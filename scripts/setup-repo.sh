#!/usr/bin/env bash
set -euo pipefail

# Config-as-code for this repo's continuous-delivery settings.
# Run ONCE after the GitHub repo exists. Requires the gh CLI authenticated with
# admin on the repo (gh auth login). Run from the repo root.
#
#   scripts/setup-repo.sh [owner/repo]
#
# Re-running is mostly idempotent EXCEPT the ruleset POST, which creates a
# duplicate. To change the ruleset later, edit .github/ruleset.json and update
# the existing one in the repo's Settings > Rules (or PUT to /rulesets/{id}).

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
echo "Configuring ${REPO} ..."

# 1) Merge hygiene: squash-only (keeps main linear), auto-delete merged branches,
#    enable auto-merge, and build the squash commit from the PR title/body so the
#    Conventional-Commit PR title becomes the commit message.
gh api -X PATCH "repos/${REPO}" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -F allow_auto_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY >/dev/null
echo "  ✓ merge settings (squash-only, auto-delete, auto-merge)"

# 2) Branch ruleset on the default branch: PR required, CI 'verify' must pass
#    (strict = branch up to date), linear history, no force-push, no deletion.
#
#    SQUASH IS PINNED IN THE RULESET, not only in the merge settings above.
#    Linear history is law here, and it was previously held by the repo setting
#    alone while the ruleset would have accepted a merge commit — two sources of
#    truth that happened to agree. One source is this repo's whole posture, so the
#    ruleset now states it too (`allowed_merge_methods: ["squash"]`).
#
#    ADMIN BYPASS IS `always`, AND THAT IS A DECISION RATHER THAN A DEFAULT.
#    This is a solo repo with exactly one admin, who is also the only person the
#    protection is defending against. Narrowing the bypass to `pull_request` would
#    remove the break-glass hatch to protect the repo from the one party it already
#    trusts completely — cost with no corresponding risk retired. The hatch is the
#    point: it exists so a broken `main` can be repaired when the gate itself is
#    what is broken. Reconsider only if a second admin is ever added, at which
#    point the trust assumption stops holding.
gh api -X POST "repos/${REPO}/rulesets" --input .github/ruleset.json >/dev/null
echo "  ✓ ruleset 'main-protection' applied"

echo "Done. Verify with:  gh api repos/${REPO}/rulesets -q '.[].name'"
