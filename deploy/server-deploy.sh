#!/usr/bin/env bash
set -Eeuo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV CDPATH ENV GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_COUNT
unset GIT_DIR GIT_OBJECT_DIRECTORY GIT_WORK_TREE
umask 022

readonly REPOSITORY_URL="https://github.com/Ohmnitude/custom-for-all.git"
readonly STATIC_ROOT="/srv/client-sites/custom-for-all"
readonly BACKEND_ROOT="/srv/client-services/custom-for-all-form"
readonly TRUSTED_DOCKERFILE="/usr/local/lib/custom-for-all/Dockerfile"
readonly FORM_SERVICE="custom-for-all-form.service"
readonly PUBLIC_URL="https://cfa.ohmnitude.net"
readonly LOCK_FILE="/run/lock/custom-for-all-deploy.lock"

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: deploy-custom-for-all <40-character-git-revision>" >&2
  exit 64
fi

readonly revision="$1"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another Custom For All deployment is still running." >&2
  exit 75
fi

work_dir="$(mktemp -d /tmp/custom-for-all-deploy.XXXXXX)"
repo_dir="$work_dir/repository"
build_dir="$work_dir/form-build"
export HOME="$work_dir/home"
export DOCKER_CONFIG="$work_dir/docker-config"
install -d -m 0700 "$HOME" "$DOCKER_CONFIG"
old_static_target="$(readlink -f "$STATIC_ROOT/current" 2>/dev/null || true)"
old_backend_target="$(readlink -f "$BACKEND_ROOT/current" 2>/dev/null || true)"
old_image_id="$(docker image inspect custom-for-all-form:local --format '{{.Id}}' 2>/dev/null || true)"
backend_updated=false
static_updated=false
candidate_image="custom-for-all-form:deploy-${revision:0:12}"

cleanup() {
  rm -rf -- "$work_dir"
  docker image rm "$candidate_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

atomic_link() {
  local root="$1"
  local target="$2"
  local temporary="$root/.current-${revision:0:12}-$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$root/current"
}

rollback() {
  local exit_code=$?
  trap - ERR

  if [[ "$static_updated" == true && -n "$old_static_target" ]]; then
    atomic_link "$STATIC_ROOT" "$old_static_target" || true
  fi

  if [[ "$backend_updated" == true ]]; then
    if [[ -n "$old_backend_target" ]]; then
      atomic_link "$BACKEND_ROOT" "$old_backend_target" || true
    fi
    if [[ -n "$old_image_id" ]]; then
      docker tag "$old_image_id" custom-for-all-form:local || true
      systemctl restart "$FORM_SERVICE" || true
    fi
  fi

  echo "Deployment failed; the previous release was restored." >&2
  exit "$exit_code"
}
trap rollback ERR

git init -q "$repo_dir"
git -C "$repo_dir" remote add origin "$REPOSITORY_URL"
git -C "$repo_dir" fetch --quiet --depth=1 origin "$revision"
fetched_revision="$(git -C "$repo_dir" rev-parse FETCH_HEAD)"
if [[ "$fetched_revision" != "$revision" ]]; then
  echo "GitHub returned an unexpected revision." >&2
  exit 65
fi
git -C "$repo_dir" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD

for required_file in index.html server.mjs package.json package-lock.json; do
  if [[ ! -f "$repo_dir/$required_file" || -L "$repo_dir/$required_file" ]]; then
    echo "Required regular file is missing: $required_file" >&2
    exit 66
  fi
done
if [[ ! -d "$repo_dir/assets" || -L "$repo_dir/assets" ]]; then
  echo "The assets directory is missing or unsafe." >&2
  exit 66
fi
if find "$repo_dir/assets" -type l -print -quit | grep -q .; then
  echo "Symbolic links are not allowed in public assets." >&2
  exit 66
fi
if [[ ! -f "$TRUSTED_DOCKERFILE" || -L "$TRUSTED_DOCKERFILE" ]]; then
  echo "The trusted form-service Dockerfile is unavailable." >&2
  exit 69
fi

backend_digest="$({
  sha256sum "$repo_dir/server.mjs"
  sha256sum "$repo_dir/package.json"
  sha256sum "$repo_dir/package-lock.json"
} | sha256sum | awk '{print $1}')"
current_backend_digest=""
if [[ -f "$BACKEND_ROOT/current/.source-digest" ]]; then
  current_backend_digest="$(<"$BACKEND_ROOT/current/.source-digest")"
fi

release_id="$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}-$$"

if [[ "$backend_digest" != "$current_backend_digest" ]]; then
  install -d -m 0755 "$build_dir"
  install -m 0644 "$repo_dir/server.mjs" "$build_dir/server.mjs"
  install -m 0644 "$repo_dir/package.json" "$build_dir/package.json"
  install -m 0644 "$repo_dir/package-lock.json" "$build_dir/package-lock.json"

  docker build --file "$TRUSTED_DOCKERFILE" --tag "$candidate_image" "$build_dir"
  docker tag "$candidate_image" custom-for-all-form:local

  backend_release="$BACKEND_ROOT/releases/$release_id"
  install -d -m 0755 "$backend_release"
  install -m 0644 "$repo_dir/server.mjs" "$backend_release/server.mjs"
  install -m 0644 "$repo_dir/package.json" "$backend_release/package.json"
  install -m 0644 "$repo_dir/package-lock.json" "$backend_release/package-lock.json"
  printf '%s\n' "$backend_digest" > "$backend_release/.source-digest"
  printf '%s\n' "$revision" > "$backend_release/.git-revision"
  atomic_link "$BACKEND_ROOT" "$backend_release"
  backend_updated=true

  systemctl restart "$FORM_SERVICE"
  systemctl is-active --quiet "$FORM_SERVICE"

  for attempt in {1..20}; do
    health="$(docker inspect custom-for-all-form --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    if [[ "$health" == healthy ]]; then
      break
    fi
    if [[ "$attempt" -eq 20 ]]; then
      echo "The form service did not become healthy." >&2
      exit 70
    fi
    sleep 2
  done
fi

static_release="$STATIC_ROOT/releases/$release_id"
install -d -m 0755 "$static_release/assets"
install -m 0644 "$repo_dir/index.html" "$static_release/index.html"
cp -a "$repo_dir/assets/." "$static_release/assets/"
find "$static_release/assets" -type d -exec chmod 0755 {} +
find "$static_release/assets" -type f -exec chmod 0644 {} +
chown -R root:root "$static_release"
printf '%s\n' "$revision" > "$static_release/.git-revision"
atomic_link "$STATIC_ROOT" "$static_release"
static_updated=true

curl --fail --silent --show-error --retry 5 --retry-delay 2 --output /dev/null "$PUBLIC_URL/?deploy=$revision"
curl --fail --silent --show-error --retry 5 --retry-delay 2 --output /dev/null "$PUBLIC_URL/api/config"

trap - ERR
echo "Deployed $revision to $PUBLIC_URL"
