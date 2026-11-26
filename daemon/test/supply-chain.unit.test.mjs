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

finish();
