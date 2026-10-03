/**
 * dsh-codehub — host-bundle load smoke test.
 *
 * Answers one question: when DSH's loader imports `lib/index.mjs`, what kind of
 * failure (if any) happens at module-evaluation time?
 *
 * The expected answer in a plain Node process is a RESOLUTION failure on
 * `@deepseek-ai/*`. That is benign — the DSH SDK is not installed on disk; the
 * loader injects it at runtime, which is exactly why it is marked external in
 * tsdown.config.ts. A resolution error here therefore says nothing bad about the
 * plugin.
 *
 * What WOULD be bad — and what this test exists to catch before a restart — is a
 * syntax error or a throw during top-level evaluation. Those fail the plugin
 * inside DSH too, and because the profile composes one plugin tree, a bad half
 * can keep the whole GUI from coming up.
 *
 * Run: node scripts/check-host-load.mjs
 */

try {
  await import('file:///D:/dsh-codehub/lib/index.mjs')
  console.log('IMPORT_OK   host bundle evaluated with no error')
} catch (error) {
  const code = error?.code ?? '(none)'
  console.log(`IMPORT_FAIL name=${error?.name} code=${code}`)
  console.log(`            msg=${String(error?.message).slice(0, 200)}`)
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
    console.log('            -> resolution error only (expected: @deepseek-ai/* comes from the DSH loader)')
  } else {
    console.log('            -> NOT a resolution error: an evaluation-time fault would break the plugin in DSH')
    process.exitCode = 1
  }
}
