# Disabled upstream workflows

These workflows are preserved byte-for-byte from the Swift upstream baseline but intentionally live outside
`.github/workflows/`, so GitHub cannot execute them while the TypeScript port is incomplete.

New TypeScript workflows will be created only after the local cross-platform gate passes. Release, signing,
notarization, package publishing, and auto-update remain disabled until separately authorized.
