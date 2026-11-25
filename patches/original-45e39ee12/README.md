# Original patches (base `v2` `45e39ee12`)

The patches as first submitted: PR #2590 as `d5733f56b` and PR #2595 as `2c8de9c7e`. The benchmark, the regression gate and the release-note and description checks ran on these commits, so their results stay tied to them.

The patches in the folder above are the rebased versions, against `v2` `7cabe226e`. They differ from these only in two small conflict resolutions with upstream's comment removals and in the removal of prose comments, which upstream's new `executor/no-comments` lint rule forbids. The code is the same.
