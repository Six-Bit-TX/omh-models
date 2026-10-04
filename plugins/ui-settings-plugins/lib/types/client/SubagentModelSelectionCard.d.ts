/**
 * User control for model-selectable subagent delegation in new sessions.
 *
 * The authorized-route list carries a search field that narrows the loaded
 * catalog locally, mirroring the composer model seat's matching: a
 * case-insensitive substring of the provider's display name, the model's
 * display name, or its id, where a provider whose own name matches keeps its
 * complete list. Two kinds of row ignore the query — a route currently checked
 * and a saved route the catalog no longer advertises — because this list edits
 * authorization and shows the checked set nowhere else, so a search must never
 * hide a row whose state the user can see or change.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SubagentModelSelectionCardFace } from './subagent-model-selection-card-controller.ts';
/** Props the renderer binds for the subagent model-selection card. */
export type SubagentModelSelectionCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'settings.plugins'> & InjectFace<SubagentModelSelectionCardFace>;
/**
 * Render the default-off preference and its exact adapter-route choices.
 * @param props - locale copy, the card snapshot, and its toggle action.
 * @returns the preference card, or nothing when the namespace is unavailable.
 */
export declare function SubagentModelSelectionCard(props: SubagentModelSelectionCardProps): import("react").JSX.Element;