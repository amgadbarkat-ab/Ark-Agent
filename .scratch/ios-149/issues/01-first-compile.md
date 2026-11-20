# First compile in CI

Status: claimed

- `mobile-ios.yml` runs on push to `claude/ios-*` as well as main and PRs.
- Simulator build, `CODE_SIGNING_ALLOWED=NO`, no secrets, made-up names except the bundle id, which is
  now fixed.
- Print the Xcode version first so a toolchain mismatch reads as one.

## Comments
