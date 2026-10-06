/**
 * dsh-codehub — the credential guide (「单独一个界面手把手教」).
 *
 * WHY A SEPARATE WIZARD INSTEAD OF A BIGGER DIALOG
 * ------------------------------------------------
 * Getting a credential is 3–4 browser steps that differ per source: create an
 * OAuth App and tick Device Flow (GitHub), register a callback and create an
 * application (Gitee), copy a Cookie request header out of DevTools (CSDN). The
 * step text therefore comes from `LOGIN_GUIDES` / `loginGuideFor()` in the frozen
 * contract — this file renders it, it does not re-write it.
 *
 * VALUE HANDLING (the security contract of this file)
 * --------------------------------------------------
 * 1. Values live in component state only: the controlled input, and the request
 *    body built from it. Nothing goes to the config store, localStorage, a URL or
 *    a log line. There is no code path here that can display a value it does not
 *    have, and every value field is `type="password"`.
 * 2. The ONE value that outlives a single request is the Gitee `clientSecret`:
 *    the same secret is needed both to start the flow and to complete it when the
 *    callback never arrives. It is therefore kept (masked) until the FLOW
 *    settles, and cleared on close — never persisted, never sent anywhere but
 *    those two request bodies. Every other value is cleared as soon as its
 *    request settles.
 * 3. The device-flow `userCode` and the authorization `code` are NOT rendered
 *    from the host payload beyond what the host already sends by design; only
 *    the CDP result (cookie NAMES and a count) is shown, never a cookie value.
 */
import type { ReactElement } from 'react';
import type { LoginMethodId, SourceId } from '../contract.js';
import type { Translate } from './locales.js';
export interface CredentialGuideState {
    open: boolean;
    source: SourceId | null;
    method: LoginMethodId | null;
}
export declare function subscribeCredentialGuide(listener: () => void): () => void;
export declare function getCredentialGuideState(): CredentialGuideState;
export declare function useCredentialGuideState(): CredentialGuideState;
/** Open the wizard for one source; the method defaults to that source's first. */
export declare function openCredentialGuide(source: SourceId, method?: LoginMethodId): void;
export declare function closeCredentialGuide(): void;
export interface CredentialGuideProps {
    t?: Translate;
}
/**
 * Rendered from the `shell.overlay` seat. It subscribes to its own store, so the
 * parent does not need to pass open/close state (and a closed login dialog can
 * never take the wizard down with it).
 */
export declare function CredentialGuide(props: CredentialGuideProps): ReactElement | null;
