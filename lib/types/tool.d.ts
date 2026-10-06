/**
 * dsh-codehub — the `learn_code_from_web` agent tool.
 *
 * WHAT THIS TOOL IS FOR (备注③)
 * ----------------------------
 * Learning usage, not moving code. Its description carries
 * `ANTI_COPY_TOOL_CLAUSE` verbatim — imported from `src/contract.ts`, never
 * re-typed — and that clause embeds the single `ANTI_COPY_STATEMENT` the system
 * prompt section also uses. A test asserts both surfaces contain the same
 * constant, which only means something because there is exactly one copy.
 *
 * FAILURES ARE VALUES
 * -------------------
 * A refusal (an unanswered decision, the plugin disabled, every source empty) is
 * returned as `{ ok: false, ... }` in the declared output schema, because the
 * model must be able to branch on it. `throw` is reserved for the caller using
 * the tool wrongly — a missing `query`, a `sources` value outside the enum, a
 * `maxItems` that is not a positive integer — and every such message starts with
 * `dsh-codehub: ` so it is obvious where it came from.
 *
 * The definition is built by `buildLearnCodeTool(deps)`; `LEARN_CODE_TOOL` is a
 * ready-made instance whose `description`, `parameters` and `output` are static,
 * so tests can import it and inspect the description without a live service.
 */
import type { ObjectSchema, ToolDefinition } from '@deepseek-ai/dsh-tools';
import { TOOL_PARAMS } from './contract.js';
import type { SourceId } from './contract.js';
import type { CodeSource } from './service.js';
/**
 * The tool description.
 *
 * Composed from the contract clause; the surrounding sentences only explain the
 * decision gate and the note-shaped output, they do not restate the boundary.
 */
export declare const LEARN_CODE_TOOL_DESCRIPTION: string;
export interface LearnCodeArgs {
    readonly query: string;
    readonly sources?: readonly SourceId[] | undefined;
    readonly deepRead?: boolean | undefined;
    readonly maxItems?: number | undefined;
}
/** One JSON-Schema node, in the subset this tool's arguments use. */
export interface ParamNode {
    readonly type: 'string' | 'integer' | 'boolean' | 'array' | 'object';
    readonly description?: string;
    readonly enum?: readonly string[];
    readonly items?: ParamNode;
}
/**
 * The arguments schema the provider receives.
 *
 * Deliberately a `type` alias (not an `interface`): an object literal type
 * carries an implicit index signature, which is what makes it assignable to the
 * runtime's `Record<string, unknown>` `parameters` field without a cast.
 */
export type LearnCodeParameters = {
    readonly type: 'object';
    readonly additionalProperties: false;
    readonly required: readonly string[];
    readonly properties: Readonly<Record<(typeof TOOL_PARAMS)[number], ParamNode>>;
};
/**
 * The required parameter names, in the top-level array form.
 *
 * The array form is load-bearing for the same reason it is in the output schema:
 * a boolean `required` on a property is not valid JSON Schema here.
 */
export declare const LEARN_CODE_REQUIRED_PARAMS: readonly string[];
/** The compiled `parameters` schema. See the section header for why it is raw. */
export declare const LEARN_CODE_PARAMETERS: LearnCodeParameters;
/** Declared parameter names, in contract order. */
export declare const LEARN_CODE_PARAM_NAMES: readonly string[];
export declare const LEARN_CODE_OUTPUT_SCHEMA: ObjectSchema;
export interface LearnCodeToolDeps {
    /** The live service. Omitted only for the static `LEARN_CODE_TOOL` instance. */
    readonly service?: CodeSource | undefined;
    /** Current limits; the timeout budget comes from here, not from a constant. */
    readonly getLimits?: (() => {
        readonly timeoutMs: number;
    }) | undefined;
}
/**
 * Build the tool definition.
 *
 * The timeout is composed with `AbortSignal.any([exec.signal, AbortSignal.timeout(limits.timeoutMs)])`
 * (see `composeSignal`), so a caller cancellation and our own budget both stop
 * the request, and the definition-level `timeoutMs` is only the contract's hard
 * cap — a backstop, never a tighter bound than the user's own setting.
 */
export declare function buildLearnCodeTool(deps?: LearnCodeToolDeps): ToolDefinition;
/**
 * A ready-made instance for import-time inspection (tests read `description`).
 * Its `execute` refuses because no service is wired — which is exactly the
 * "caller used it wrongly" path and therefore a throw, not a silent no-op.
 */
export declare const LEARN_CODE_TOOL: ToolDefinition;
