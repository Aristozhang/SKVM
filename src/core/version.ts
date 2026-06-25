/**
 * Hard-coded version string.
 *
 * The compiled binary (`bun build --compile`) cannot reliably resolve
 * `import … from "../package.json" with { type: "json" }` at runtime on
 * Windows — the virtual-fs path resolution breaks and the binary crashes
 * with ENOENT.  We therefore keep the version in exactly one place
 * (this file) and import it everywhere else.
 *
 * IMPORTANT: bump this together with package.json "version" before tagging
 * a release.  The CI release workflow patches package.json from the git tag,
 * so add a matching sed / node one-liner there if you automate it.
 */
export const SKVM_VERSION = "0.1.10"
