import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PlanDiscussPhase } from '../types'


const phase = atom({ plugin: 'plan-discuss', key: 'phase' } as const, 'off' as PlanDiscussPhase)
const inPlan = atom({ plugin: 'plan-discuss', key: 'inPlan' } as const, false)
const planFile = atom({ plugin: 'plan-discuss', key: 'planFile' } as const, null as string | null)
const returnToDiscuss = atom({ plugin: 'plan-discuss', key: 'returnToDiscuss' } as const, false)
const isHidden = atom({ plugin: 'plan-discuss', key: 'isHidden' } as const, false)

const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/

const DISCUSS_CONTEXT = [
  '[plan-discuss] PLAN DISCUSSION MODE is on.',
  'The plan file is written and the user is now reviewing it. Treat this message as a question or comment ABOUT the plan, not as a request to change it.',
  'Rules for this turn:',
  '- Answer the question in conversation, grounded in the plan file and the code. Reading files and searching are fine.',
  '- Do NOT edit or rewrite the plan file. Do NOT call ExitPlanMode. Both are blocked in this mode.',
  '- If the user seems to want a change, describe concretely what you would change and tell them to run `/plan-edit <instruction>` (one-shot revision) or `/plan-edit` (stay in edit mode) to apply it. Tell them `/plan-go` approves the plan and starts implementation.',
  '- Keep the plan file path in mind; quote the relevant section when it helps.',
  'Reply in the language the user writes in.',
].join('\n')

const EDIT_CONTEXT = [
  '[plan-discuss] PLAN EDIT MODE is on.',
  'You may revise the plan file now. Do NOT call ExitPlanMode: the user approves with /plan-go when ready.',
  'After editing, summarize what changed in a few lines.',
].join('\n')

async function showStatus($: Pick<EngineInterface, 'ui' | 'state'>): Promise<void> {
  const [isIn, ph] = await Promise.all([read($, inPlan), read($, phase)])
  if (!isIn || ph === 'off') {
    $.ui.status(undefined)
    return
  }
  const label = ph === 'discuss' ? '💬 계획 토론' : ph === 'edit' ? '✎ 계획 수정' : '▶ 계획 승인됨'
  $.ui.status(label)
}

async function setPhase(
  $: Pick<EngineInterface, 'ui' | 'state'>,
  next: PlanDiscussPhase,
): Promise<void> {
  await update($, phase, () => next)
  await update($, isHidden, () => false)
  await showStatus($)
}

function approvePrompt(note: string): string {
  const extra = note.trim() ? `\n\n추가 지시: ${note.trim()}` : ''
  return [
    '계획을 승인합니다. 지금 바로 ExitPlanMode를 호출해서 계획을 확정하고, 확정되면 계획서대로 구현을 시작해줘.',
    '구현 중에는 계획서의 단계를 순서대로 따르고, 각 단계가 끝날 때 짧게 진행 상황을 알려줘.',
  ].join(' ') + extra
}

function editPrompt(instruction: string): string {
  return [
    `계획서를 다음 지시대로 수정해줘: ${instruction.trim()}`,
    '수정은 계획서 파일에 반영하고, ExitPlanMode는 호출하지 말고 무엇이 바뀌었는지만 짧게 요약해줘.',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const approveMode = String(options.approveMode ?? 'auto')
  const interceptExit = options.interceptExit !== false

  // ---- commands --------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({
        name: 'plan-talk',
        description: '계획 토론 모드: 계획서에 대해 질문만 하고, 계획서는 수정하지 않음',
      }),
      $.command.register({
        name: 'plan-edit',
        description: '계획 수정 모드. 지시를 붙이면 그 지시로 한 번 수정하고 토론 모드로 복귀',
        argumentHint: '[수정 지시]',
      }),
      $.command.register({
        name: 'plan-go',
        description: `계획 승인: ExitPlanMode 후 ${approveMode === 'dialog' ? '승인 다이얼로그' : approveMode + ' 모드'}로 구현 시작`,
        argumentHint: '[추가 지시]',
      }),
    ])
    await showStatus($)
    return next(e)
  })

  on('command.run', { command: 'plan-talk' }, async $ => {
    if (!(await read($, inPlan))) {
      return { text: 'plan-discuss: 지금은 plan 모드가 아닙니다. plan 모드에서 계획서가 작성된 뒤에 쓰세요.' }
    }
    await update($, returnToDiscuss, () => false)
    await setPhase($, 'discuss')
    return {
      text: '💬 계획 토론 모드. 계획서에 대해 자유롭게 질문하세요. 계획서는 수정되지 않습니다. 수정은 /plan-edit, 승인은 /plan-go.',
    }
  })

  on('command.run', { command: 'plan-edit' }, async ($, e) => {
    if (!(await read($, inPlan))) {
      return { text: 'plan-discuss: 지금은 plan 모드가 아닙니다.' }
    }
    const instruction = e.args.trim()
    await setPhase($, 'edit')
    if (instruction === '') {
      await update($, returnToDiscuss, () => false)
      return { text: '✎ 계획 수정 모드. 이제 하는 말은 계획서 수정 지시로 처리됩니다. 토론으로 돌아가려면 /plan-talk.' }
    }
    await update($, returnToDiscuss, () => true)
    void $.prompt.submit({ text: editPrompt(instruction), asUser: true })
    return { text: '✎ 계획서를 한 번 수정하고 토론 모드로 돌아옵니다.' }
  })

  on('command.run', { command: 'plan-go' }, async ($, e) => {
    if (!(await read($, inPlan))) {
      return { text: 'plan-discuss: 지금은 plan 모드가 아닙니다.' }
    }
    await update($, returnToDiscuss, () => false)
    await setPhase($, 'approved')
    void $.prompt.submit({ text: approvePrompt(e.args), asUser: true })
    const how = approveMode === 'dialog' ? '승인 다이얼로그가 뜹니다' : `${approveMode} 모드로 전환되어 구현이 시작됩니다`
    return { text: `▶ 계획 승인. ExitPlanMode 후 ${how}.` }
  })

  // ---- plan mode tracking ----------------------------------------------

  on('prompt.attachment', { type: 'plan_mode' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, inPlan, () => true)
      if (e.detail?.planFilePath) {
        const path = e.detail.planFilePath
        await update($, planFile, () => path)
      }
      await showStatus($)
    }
    return next(e)
  })

  on('prompt.attachment', { type: 'plan_mode_exit' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, inPlan, () => false)
      await update($, returnToDiscuss, () => false)
      await setPhase($, 'off')
    }
    return next(e)
  })

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError === undefined) {
      await update($, inPlan, () => true)
      await update($, returnToDiscuss, () => false)
      await setPhase($, 'off')
    }
    return ran
  })

  // ---- the gate: ExitPlanMode ------------------------------------------

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ph = await read($, phase)
    const file = await read($, planFile)

    const mustIntercept = ph === 'discuss' || ph === 'edit' || (ph === 'off' && interceptExit)
    if (mustIntercept) {
      await update($, inPlan, () => true)
      await update($, returnToDiscuss, () => false)
      await setPhase($, 'discuss')
      $.ui.toast('💬 계획서 작성 완료 · 토론 모드. 질문하세요. 승인은 /plan-go')
      const where = file ? ` at ${file}` : ''
      return {
        deny: [
          `plan-discuss: the plan is NOT approved yet, and the user wants to review and discuss it before approving.`,
          `Do NOT call ExitPlanMode again, and do not edit the plan file further in this turn.`,
          `End your turn now with a short message in the user's language: the plan is written${where} and ready for discussion.`,
          `Tell the user they can ask questions about it, run /plan-edit <instruction> to have it revised, or /plan-go to approve it and start implementation.`,
        ].join(' '),
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === undefined) {
      await update($, inPlan, () => false)
      await update($, returnToDiscuss, () => false)
      await setPhase($, 'off')
      if (ph === 'approved') $.ui.toast('▶ 계획 승인 완료 · 구현 시작')
    }
    return ran
  })

  // /plan-go 뒤의 ExitPlanMode 승인 다이얼로그를 대신 답하고 권한 모드를 바꾼다.
  on('classic.PermissionRequest', { tool_name: 'ExitPlanMode' }, async ($, e, next) => {
    if (approveMode === 'dialog') return next(e)
    if ((await read($, phase)) !== 'approved') return next(e)
    const mode = approveMode as 'auto' | 'acceptEdits' | 'default' | 'bypassPermissions'
    return {
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
      },
    }
  })

  // ---- discuss mode: the plan file is read-only ------------------------

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (!(await read($, inPlan)) || (await read($, phase)) !== 'discuss') return next(e)
    const target = 'file_path' in e ? String(e.file_path) : 'notebook_path' in e ? String(e.notebook_path) : 'a file'
    return {
      deny: `plan-discuss: discussion mode is on, so ${target} stays as it is. Answer the user's question instead; if they want this change, tell them to run /plan-edit <instruction>.`,
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'plan-discuss: discussion mode guard failed; the plan file stays as it is.' },
  )

  // ---- what the model reads beside each prompt --------------------------

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true) return next(e)
    if (!(await read($, inPlan))) return next(e)
    const ph = await read($, phase)
    if (ph === 'discuss') {
      return next({ ...e, context: [...(e.context ?? []), DISCUSS_CONTEXT] })
    }
    if (ph === 'edit') {
      return next({ ...e, context: [...(e.context ?? []), EDIT_CONTEXT] })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, returnToDiscuss))) {
      await update($, returnToDiscuss, () => false)
      if (await read($, inPlan)) await setPhase($, 'discuss')
    }
    return next(e)
  })

  // ---- the band above the prompt ---------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [isIn, ph, hidden, file] = await Promise.all([
      read($, inPlan),
      read($, phase),
      read($, isHidden),
      read($, planFile),
    ])
    if (e.props.hasSurvey || !isIn || ph === 'off' || hidden) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const name = file ? file.split('/').pop() : null

    const headline =
      ph === 'discuss'
        ? '💬 계획 토론 모드 · 질문/검토만, 계획서는 수정되지 않음'
        : ph === 'edit'
          ? '✎ 계획 수정 모드 · 하는 말이 계획서 수정 지시로 처리됨'
          : '▶ 계획 승인됨 · ExitPlanMode 후 구현 시작'

    const goLabel = approveMode === 'dialog' ? '승인 (다이얼로그)' : `승인 → ${approveMode}`

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="planMode" bold>
            {headline}
          </Text>
          {name && <Text dimColor> · {name}</Text>}
        </Box>
        <Box>
          {ph !== 'discuss' && (
            <Button
              key="talk"
              label="토론 모드"
              hotkey="t"
              onPress={async () => {
                await update($, returnToDiscuss, () => false)
                await setPhase($, 'discuss')
              }}
            />
          )}
          {ph !== 'edit' && ph !== 'approved' && (
            <Button
              key="edit"
              label="수정 모드"
              hotkey="e"
              onPress={async () => {
                await update($, returnToDiscuss, () => false)
                await setPhase($, 'edit')
              }}
            />
          )}
          {ph !== 'approved' && (
            <Button
              key="go"
              label={goLabel}
              hotkey="g"
              variant="primary"
              onPress={async () => {
                await update($, returnToDiscuss, () => false)
                await setPhase($, 'approved')
                void $.prompt.submit({ text: approvePrompt(''), asUser: true })
              }}
            />
          )}
          <Button key="hide" label="숨기기" onPress={() => update($, isHidden, () => true)} />
          <Text dimColor> /plan-talk · /plan-edit [지시] · /plan-go [지시]</Text>
        </Box>
      </Box>
    )
  })
}
