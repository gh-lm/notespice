#!/usr/bin/env bash
# Publishes the current main to GitHub as Lightmorphic, leaving out the
# files that are ours alone. charlie-tasks.md names paths inside the
# secrets folder, so it must never reach the public repository.
#
#   tools/push_public.sh "Commit subject"
#
# The token is read straight into the environment and handed to git by a
# one-shot credential helper, so it never lands in a file or in the
# remote URL.
set -euo pipefail

SUBJECT="${1:?give a commit subject}"
REPO="$(git rev-parse --show-toplevel)"
PRIVATE_ONLY=(charlie-tasks.md)

cd "$REPO"
TMP_INDEX="$(mktemp -u /tmp/notespice-pubindex.XXXXXX)"
trap 'rm -f "$TMP_INDEX"' EXIT

GIT_INDEX_FILE="$TMP_INDEX" git read-tree main
for f in "${PRIVATE_ONLY[@]}"; do
  GIT_INDEX_FILE="$TMP_INDEX" git update-index --force-remove "$f"
done
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"

PARENT="$(git rev-parse --verify --quiet refs/heads/public-main || true)"
PARENT_ARG=()
[ -n "$PARENT" ] && PARENT_ARG=(-p "$PARENT")

COMMIT="$(
  GIT_AUTHOR_NAME=Lightmorphic \
  GIT_AUTHOR_EMAIL=342227218+gh-lm@users.noreply.github.com \
  GIT_COMMITTER_NAME=Lightmorphic \
  GIT_COMMITTER_EMAIL=342227218+gh-lm@users.noreply.github.com \
  git commit-tree "$TREE" "${PARENT_ARG[@]}" -m "$SUBJECT"
)"
git update-ref refs/heads/public-main "$COMMIT"

GH_TOKEN="$(tr -d '\r\n' < "$HOME/9-Claude/secrets/notespice/notespice-gh-token")"
export GH_TOKEN
git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
    push github public-main:refs/heads/main

echo "published $COMMIT"
