#!/usr/bin/env bun
// Build, verify, and publish this package at package.json's current version —
// the single-package, Bun-native equivalent of smithers' `pnpm release`.
// Bump the version + add a CHANGELOG entry first, then run `bun run release`.
//
// Usage:
//   bun run release                  # clean-tree, changelog, build, typecheck, test, publish, tag, gh release
//   bun run release --dry-run        # everything except `bun publish` and pushing the tag
//   bun run release --otp=123456     # npm 2FA one-time password
//   bun run release --tag=next       # publish under a dist-tag other than latest
//   bun run release --skip-build
//   bun run release --skip-checks    # skip typecheck + test
//   bun run release --skip-git       # skip the clean-tree check
//   bun run release --skip-gh-release

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY_RUN = !!args["dry-run"];
const SKIP_BUILD = !!args["skip-build"];
const SKIP_CHECKS = !!args["skip-checks"];
const SKIP_GIT = !!args["skip-git"];
const SKIP_GH_RELEASE = !!args["skip-gh-release"];
const OTP = typeof args.otp === "string" ? args.otp : null;
const DIST_TAG = typeof args.tag === "string" ? args.tag : null;

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { name, version } = pkg;
const tag = `v${version}`;

function log(step, msg) {
  console.log(`\n▸ [${step}] ${msg}`);
}
function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}
function gitStatusPorcelain() {
  const out = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git status failed:\n${out.stderr ?? ""}`);
  return out.stdout.trim();
}

/** owner/repo from the origin remote, so a repo rename never needs a code edit. */
function deriveGhRepo() {
  const out = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  const url = (out.stdout ?? "").trim();
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}
const GH_REPO = deriveGhRepo();

/** The CHANGELOG.md body for `version`: the lines between its `## ` heading and the next. */
function changelogSection() {
  const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s*\\[?${escaped}\\]?(?:\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim() || null;
}

log("version", `releasing ${name}@${version}`);

// 1. Changelog entry must exist for this version.
const notes = changelogSection();
if (!notes) {
  throw new Error(`CHANGELOG.md has no "## ${version}" section — add the release notes before releasing.`);
}

// 2. Clean working tree (bump + commit + tag should already be done).
if (!SKIP_GIT) {
  log("git", "checking clean working tree");
  const dirty = gitStatusPorcelain();
  if (dirty) {
    throw new Error(
      `working tree is dirty — commit the version bump + CHANGELOG first, or pass --skip-git:\n${dirty}`,
    );
  }
}

// 3. Build.
if (!SKIP_BUILD) {
  log("build", "bun run build");
  run("bun run build");
  if (!SKIP_GIT) {
    const drift = gitStatusPorcelain();
    if (drift) {
      throw new Error(`\`bun run build\` changed tracked files — commit them before releasing:\n${drift}`);
    }
  }
} else {
  log("build", "skipped (--skip-build)");
}

// 4. Checks.
if (!SKIP_CHECKS) {
  log("typecheck", "bun run typecheck");
  run("bun run typecheck");
  log("test", "bun test");
  run("bun test");
} else {
  log("checks", "skipped (--skip-checks)");
}

// 5. Already on the registry? (npm registry HTTP API — no npm CLI needed.)
log("registry", `checking registry for ${name}@${version}`);
let alreadyPublished = false;
try {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  if (res.status === 200) alreadyPublished = true;
  else if (res.status !== 404) throw new Error(`unexpected registry status ${res.status}`);
} catch (e) {
  console.log(`  could not reach the registry (${e.message}) — continuing; bun publish will reject a duplicate`);
}

// 6. Publish with Bun.
const publishArgs = ["publish", "--access", "public"];
if (DIST_TAG) publishArgs.push("--tag", DIST_TAG);
if (OTP) publishArgs.push("--otp", OTP);
if (DRY_RUN) publishArgs.push("--dry-run");

if (alreadyPublished && !DRY_RUN) {
  log("publish", `${name}@${version} is already on the registry — skipping publish`);
} else {
  log("publish", `bun ${publishArgs.join(" ")}`);
  const out = spawnSync("bun", publishArgs, { stdio: "inherit", cwd: root });
  if (out.status !== 0) throw new Error("bun publish failed");
}

// 7. Git tag + GitHub release.
if (SKIP_GH_RELEASE) {
  log("gh-release", "skipped (--skip-gh-release)");
} else if (!GH_REPO) {
  log("gh-release", "skipped — could not derive owner/repo from the origin remote");
} else if (DRY_RUN) {
  log("gh-release", `DRY RUN — would tag ${tag} and create the GitHub release on ${GH_REPO}`);
} else {
  const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (gh.status !== 0) {
    console.log("  gh CLI not found — tag + release manually:");
    console.log(`    git tag ${tag} && git push origin ${tag}`);
    console.log(`    gh release create ${tag} --repo ${GH_REPO} --title ${tag} --notes "<changelog>"`);
  } else {
    const exists = spawnSync("gh", ["release", "view", tag, "--repo", GH_REPO], { cwd: root, encoding: "utf8" });
    if (exists.status === 0) {
      console.log(`  release ${tag} already exists — skipping`);
    } else {
      const tagOnRemote = spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", tag], { cwd: root });
      if (tagOnRemote.status !== 0) {
        log("gh-release", `tagging ${tag} and pushing to origin`);
        run(`git tag ${tag}`);
        run(`git push origin ${tag}`);
      }
      const tmp = join(root, ".release-notes.tmp.md");
      writeFileSync(tmp, notes);
      try {
        run(
          `gh release create ${tag} --repo ${GH_REPO} --title ${tag} --notes-file ${JSON.stringify(tmp)} --latest --verify-tag`,
        );
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }
}

console.log(`\n✓ ${name}@${version} ${DRY_RUN ? "(dry run) " : ""}done`);
