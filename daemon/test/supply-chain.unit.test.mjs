// Dependency verification only helps if the checksums are committed and the CI gate exists, so
// this reads both instead of trusting that the Gradle command was run once.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
const exists = (p) => fs.existsSync(path.join(REPO, p));

const metadataPath = "app/gradle/verification-metadata.xml";
check(`${metadataPath} is committed`, exists(metadataPath));
const metadata = exists(metadataPath) ? read(metadataPath) : "";
const components = (metadata.match(/<component /g) || []).length;
const digests = (metadata.match(/<sha256 /g) || []).length;
check(`the metadata covers the resolved graph (${components} components)`, components > 100);
check(`every component carries a SHA-256 (${digests} digests)`, digests > components);
check("metadata verification is on", /<verify-metadata>true<\/verify-metadata>/.test(metadata));
check("checksums are used, not signatures", /<verify-signatures>false<\/verify-signatures>/.test(metadata));
check("nothing is trusted wholesale", !/<trust-all>\s*true\s*<\/trust-all>/.test(metadata));

const workflow = ".github/workflows/supply-chain.yml";
check(`${workflow} exists`, exists(workflow));
if (exists(workflow)) {
  const wf = read(workflow);
  check("CI audits the shipped npm tree", /npm audit --omit=dev/.test(wf));
  check("CI audits the native crates", /cargo audit/.test(wf));
  check(
    "CI resolves Gradle with the committed checksums",
    /verification-metadata\.xml/.test(wf) && /gradlew/.test(wf),
  );
  check("it runs on push and pull_request", /^\s{2}push:/m.test(wf) && /^\s{2}pull_request:/m.test(wf));
}

// The BOMs are only useful if they ship with a release and match what is installed, so the
// committed daemon BOM is checked against the lock file and the workflow against both outputs.
const sbomPath = "daemon/sbom/daemon.cdx.json";
check(`${sbomPath} is committed`, exists(sbomPath));
if (exists(sbomPath)) {
  const bom = JSON.parse(read(sbomPath));
  const pkg = JSON.parse(read("daemon/package.json"));
  const lock = JSON.parse(read("daemon/package-lock.json"));
  check(
    "the daemon SBOM is CycloneDX 1.5",
    bom.bomFormat === "CycloneDX" && String(bom.specVersion).startsWith("1.5"),
  );
  check("it describes the daemon package", bom.metadata?.component?.name === "pocketdesk-daemon");

  const shipped = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
  const versions = new Map(
    (bom.components || []).map((c) => [`${c.group ? `${c.group}/` : ""}${c.name}`, c.version]),
  );
  const missing = shipped.filter((name) => !versions.has(name));
  check(
    missing.length === 0
      ? `every shipped dependency is in the SBOM (${shipped.length})`
      : `every shipped dependency is in the SBOM (missing: ${missing.join(", ")})`,
    missing.length === 0,
  );
  const stale = shipped.filter(
    (name) => versions.get(name) !== lock.packages[`node_modules/${name}`]?.version,
  );
  check(
    stale.length === 0
      ? "the SBOM versions match the lock file"
      : `the SBOM versions match the lock file (stale: ${stale.join(", ")})`,
    stale.length === 0,
  );
  const devOnly = Object.keys(pkg.devDependencies || {}).filter((name) => versions.has(name));
  check(
    devOnly.length === 0
      ? "the SBOM excludes dev-only packages"
      : `the SBOM excludes dev-only packages (leaked: ${devOnly.join(", ")})`,
    devOnly.length === 0,
  );
  check(
    "no component is missing a version",
    (bom.components || []).every((c) => c.version),
  );
}

const appBuild = read("app/app/build.gradle.kts");
check(
  "the APK SBOM reads only the release runtime graph",
  /includeConfigs\.set\(listOf\("releaseRuntimeClasspath"\)\)/.test(appBuild),
);
check("the APK SBOM is serial-free", /includeBomSerialNumber\.set\(false\)/.test(appBuild));

if (exists(workflow)) {
  const ci = read(workflow);
  check(
    "CI builds the daemon SBOM from the lock file",
    /cyclonedx-npm@7\.0\.1/.test(ci) && /--package-lock-only/.test(ci) && /--omit dev/.test(ci),
  );
  check("CI builds the APK SBOM from the release runtime graph", /cyclonedxDirectBom/.test(ci));
  check(
    "CI uploads both SBOMs",
    /upload-artifact/.test(ci) &&
      /daemon\/sbom\/daemon\.cdx\.json/.test(ci) &&
      /pocketdesk-apk-sbom\.json/.test(ci),
  );
}

const releasing = read("docs/RELEASING.md");
check(
  "RELEASING.md attaches both SBOMs to a release",
  /daemon\/sbom\/daemon\.cdx\.json/.test(releasing) && /pocketdesk-apk-sbom\.json/.test(releasing),
);

finish();
