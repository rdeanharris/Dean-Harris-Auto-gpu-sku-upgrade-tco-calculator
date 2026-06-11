#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: ./publish_to_github.sh https://github.com/OWNER/REPO.git" >&2
  exit 2
fi

remote_url="$1"

git branch -M main
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$remote_url"
else
  git remote add origin "$remote_url"
fi

git push -u origin main
