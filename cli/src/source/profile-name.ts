const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `value` is a syntactically valid profile name (any platform or backup profile). */
export function isProfileName(value: string): boolean {
  return PROFILE_NAME.test(value);
}
