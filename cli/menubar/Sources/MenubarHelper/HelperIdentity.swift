/// The compiled executable's basename (RUSH-3101).
///
/// launchd execs this bundle's Mach-O directly (`installedExecutablePath()` in
/// install-menubar.ts), bypassing LaunchServices name resolution — so this
/// literal, not CFBundleName/CFBundleDisplayName, is what macOS shows in
/// System Settings > Privacy & Security > Accessibility and in the "would like
/// to control this computer" prompt. Every basename-matching check in this
/// target reads it from here rather than re-deriving the string. The bundle id
/// and designated requirement are unrelated identifiers and are NOT this value
/// — renaming this constant alone does not affect the Accessibility grant.
enum HelperIdentity {
    static let executableName = "AGI Menu"
}
