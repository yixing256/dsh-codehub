/**
 * dsh-codehub — Gitee / CSDN / GitHub credential dialog, and the wizard entry.
 *
 * TWO WAYS IN, ONE PLACE THE VALUE CAN GO
 * ---------------------------------------
 * "浏览器登录" opens this dialog with that source's OAuth method: the dialog then
 * offers the step-by-step guide (`credential-guide.tsx`, which drives the OAuth
 * flow) plus the manual paste field as the fallback every flow needs. "令牌或
 * Cookie 导入" opens it with no method, i.e. the manual path only.
 *
 * VALUE HANDLING (the security contract of this file — unchanged, and still the
 * reason this dialog is small)
 * --------------------------------------------------
 * 1. The value exists in exactly two places: the controlled input's local state
 *    and the `POST /api/dsh-codehub/credentials` body. It is never put into the
 *    config store, never into localStorage/sessionStorage, never into a URL,
 *    never into a log line, and never into a React key or `title`.
 * 2. The field is cleared as soon as the request settles — success OR failure —
 *    so a rejected credential is not left sitting in the DOM.
 * 3. The only state rendered is the boolean `configured` flag that the route
 *    returns. There is no code path that can display a value it does not have.
 * 4. The dialog states plainly that the credential lives in the DSH credential
 *    service and never in the config file or git.
 *
 * The wizard is a SEPARATE overlay with its own store, so opening it (or closing
 * this dialog) cannot drag the other one down with it.
 *
 * A 503 means the host credential service itself is unavailable; that gets its
 * own message rather than being reported as a generic failure.
 */
import type { ReactNode } from 'react';
import type { LoginMethodId } from '../contract.js';
import type { CredentialSource } from './api.js';
import type { Translate } from './locales.js';
export interface LoginDialogState {
    open: boolean;
    source: CredentialSource | null;
    /** Which method the caller came from, so the guide opens on the right tab. */
    method: LoginMethodId | null;
}
export declare function subscribeLoginDialog(listener: () => void): () => void;
export declare function getLoginDialogState(): LoginDialogState;
export declare function useLoginDialogState(): LoginDialogState;
/** Open the dialog, optionally recording which method the user meant. */
export declare function openLoginDialog(source: CredentialSource, method?: LoginMethodId): void;
export declare function closeLoginDialog(): void;
export interface LoginOverlayProps {
    t?: Translate;
}
export declare function LoginOverlay(props: LoginOverlayProps): ReactNode;
