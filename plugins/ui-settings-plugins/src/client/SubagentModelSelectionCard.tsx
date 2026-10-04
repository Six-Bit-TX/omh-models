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

import { useMemo, useState } from 'react'
import { IconSearchOutline16, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SubagentModelCandidate,
  SubagentModelSelectionCardFace,
} from './subagent-model-selection-card-controller.ts'
import type {} from './slot-contract.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './SubagentModelSelectionCard.module.css'

/** Props the renderer binds for the subagent model-selection card. */
export type SubagentModelSelectionCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SubagentModelSelectionCardFace>

/** One provider's visible rows; candidate order is the catalog's. */
interface CandidateGroup {
  provider: string
  providerName: string
  candidates: SubagentModelCandidate[]
}

/**
 * Decide whether one row survives the filter query.
 * @param candidate - one advertised or saved route row.
 * @param needle - trimmed, lowercased query text; empty matches every row.
 * @returns true when the row stays visible.
 */
function candidateVisible(candidate: SubagentModelCandidate, needle: string): boolean {
  if (candidate.selected || !candidate.available) return true
  return candidate.providerName.toLowerCase().includes(needle)
    || candidate.modelName.toLowerCase().includes(needle)
    || candidate.model.toLowerCase().includes(needle)
}

/**
 * Render the default-off preference and its exact adapter-route choices.
 * @param props - locale copy, the card snapshot, and its toggle action.
 * @returns the preference card, or nothing when the namespace is unavailable.
 */
export function SubagentModelSelectionCard(props: SubagentModelSelectionCardProps) {
  const { t } = props
  const state = props.useSubagentModelSelectionCard(snapshot => snapshot)
  // Local filter over the loaded candidates, which is never re-read per
  // keystroke and never changes the staged selection.
  const [query, setQuery] = useState('')
  const { groups, unavailable, visible } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const groups: CandidateGroup[] = []
    const byProvider = new Map<string, CandidateGroup>()
    const unavailable: SubagentModelCandidate[] = []
    let visible = 0
    for (const candidate of state.candidates) {
      if (!candidateVisible(candidate, needle)) continue
      visible += 1
      if (!candidate.available) {
        unavailable.push(candidate)
        continue
      }
      const group = byProvider.get(candidate.provider)
      if (group === undefined) {
        const created = {
          provider: candidate.provider,
          providerName: candidate.providerName,
          candidates: [candidate],
        }
        byProvider.set(candidate.provider, created)
        groups.push(created)
      } else {
        group.candidates.push(candidate)
      }
    }
    return { groups, unavailable, visible }
  }, [state.candidates, query])
  const renderCandidate = (candidate: SubagentModelCandidate) => (
    <label key={candidate.key} className={css.model}>
      <input
        type="checkbox"
        checked={candidate.selected}
        disabled={!state.writable || state.saving}
        onChange={() => { props.toggleModel(candidate.key) }}
      />
      <span>
        <span className={css.modelName}>{candidate.modelName}</span>
        <span className={css.route}>{`${candidate.providerName} · ${candidate.provider}/${candidate.model}`}</span>
      </span>
      {!candidate.available
        ? <span className={css.unavailable}>{t('subagentModelSelectionUnavailable')}</span>
        : null}
    </label>
  )
  return (
    <PluginCard
      t={t}
      titleKey="subagentModelSelectionTitle"
      descriptionKey="subagentModelSelectionDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.permission}>
        <div className={css.toggleRow}>
          <span className={css.toggleLabel}>{t('subagentModelSelectionToggle')}</span>
          <Switch
            checked={state.enabled}
            label={t('subagentModelSelectionToggle')}
            disabled={!state.writable || state.saving}
            onChange={props.toggleEnabled}
          />
        </div>
        <p className={css.hint}>
          {t(state.enabled ? 'subagentModelSelectionChoose' : 'subagentModelSelectionOff')}
        </p>
      </div>
      {state.enabled
        ? (
          <div className={css.selection}>
            {state.catalogStatus === 'loading'
              ? <p className={css.notice} role="status">{t('subagentModelSelectionLoading')}</p>
              : null}
            {state.catalogStatus === 'error'
              ? (
                <div className={css.catalogError} role="alert">
                  <span>{t('subagentModelSelectionLoadFailed')}</span>
                  <button type="button" disabled={state.saving} onClick={props.retryCatalog}>
                    {t('subagentModelSelectionRetry')}
                  </button>
                </div>
              )
              : null}
            {state.catalogPartial
              ? <p className={css.notice}>{t('subagentModelSelectionPartial')}</p>
              : null}
            {state.candidates.length > 0
              ? (
                <>
                  <Input
                    className={css.search}
                    type="search"
                    icon={<IconSearchOutline16 aria-hidden="true" />}
                    value={query}
                    placeholder={t('subagentModelSelectionSearchPlaceholder')}
                    aria-label={t('subagentModelSelectionSearchAria')}
                    onChange={(event) => { setQuery(event.currentTarget.value) }}
                  />
                  <fieldset className={css.models}>
                    <legend>{t('subagentModelSelectionAllowed')}</legend>
                    {groups.map(group => (
                      <div key={group.provider} className={css.modelGroup}>
                        <div className={css.providerName}>{group.providerName}</div>
                        {group.candidates.map(renderCandidate)}
                      </div>
                    ))}
                    {unavailable.length > 0
                      ? (
                        <div className={css.modelGroup}>
                          <div className={css.providerName}>{t('subagentModelSelectionUnavailableGroup')}</div>
                          {unavailable.map(renderCandidate)}
                        </div>
                      )
                      : null}
                  </fieldset>
                  {state.catalogStatus === 'ready' && visible === 0
                    ? <p className={css.notice}>{t('subagentModelSelectionSearchEmpty')}</p>
                    : null}
                </>
              )
              : state.catalogStatus === 'ready'
                ? <p className={css.notice}>{t('subagentModelSelectionEmpty')}</p>
                : null}
            {state.invalid ? <p className={css.invalid}>{t('subagentModelSelectionRequired')}</p> : null}
          </div>
        )
        : null}
      {state.conflicted
        ? <p className={css.conflict} role="status">{t('subagentModelSelectionConflict')}</p>
        : null}
    </PluginCard>
  )
}
