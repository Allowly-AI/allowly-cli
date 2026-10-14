# Changelog

## 0.3.1

- Reject fractional and unsafe JSON number tokens before sending policy or
  check inputs, including values JavaScript would round to whole integers.
- Preserve the selected dashboard URL during manual setup-token login.
- Update receipt verification guidance for the published wire-5 verifier.

## 0.3.0

- Use the published SDK 0.8.0 and wire-5 verifier. This breaking release uses
  exact immutable policy editions, action decisions and typed OPA conditions.
- Keep native agent enrollment and checksum-pinned Witness helper setup.
