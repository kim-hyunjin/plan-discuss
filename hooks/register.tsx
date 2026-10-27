import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PlanDiscussPhase, PlanModelOverrides } from '../types'


const phase = atom({ plugin: 'plan-discuss', key: 'phase' } as const, 'off' as PlanDiscussPhase)
const inPlan = atom({ plugin: 'plan-discuss', key: 'inPlan' } as const, false)
const planFile = atom({ plugin: 'plan-discuss', key: 'planFile' } as const, null as string | null)
const returnToDiscuss = atom({ plugin: 'plan-discuss', key: 'returnToDiscuss' } as const, false)
const isHidden = atom({ plugin: 'plan-discuss', key: 'isHidden' } as const, false)
/** mod가 /model로 바꿔 둔 모델 (alias 그대로); null이면 바꾼 적 없음 */
const appliedModel = atom({ plugin: 'plan-discuss', key: 'appliedModel' } as const, null as string | null)
/** mod가 처음 모델을 바꾸기 전의 세션 모델. 토론/수정을 벗어나면 이걸로 되돌린다 */
const savedModel = atom({ plugin: 'plan-discuss', key: 'savedModel' } as const, null as string | null)
/** /plan-model 로 이 세션에서 고른 단계별 모델 (설정값보다 우선) */
const modelOverrides = atom(
  { plugin: 'plan-discuss', key: 'modelOverrides' } as const,
  { discuss: null, edit: null } as PlanModelOverrides,
)

/** 계획서 패널이 그리는 계획서 내용. 진입·수정·턴 종료 때 파일에서 다시 읽는다 */
const planText = atom({ plugin: 'plan-discuss', key: 'planText' } as const, null as string | null)
/** 계획서 패널이 편집 칸을 보여주는 중인지 */
const isEditingPlan = atom({ plugin: 'plan-discuss', key: 'isEditingPlan' } as const, false)
/** 사용자가 패널에서 계획서를 직접 고쳤고, 모델이 아직 그걸 모르는지 */
const userEditedPlan = atom({ plugin: 'plan-discuss', key: 'userEditedPlan' } as const, false)

const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/
const PLAN_PANE = 'plan'

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

const USER_EDITED_CONTEXT =
  '[plan-discuss] The user edited the plan file directly since your last turn. Re-read the plan file before answering; do not rely on the version you remember.'

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

type PhaseModels = { discuss: string; edit: string }
type Engine$ = Pick<EngineInterface, 'ui' | 'state' | 'clock' | 'command' | 'session'>

/** 단계에 맞는 모델 이름 (빈 문자열이면 바꾸지 않음) */
async function modelFor($: Pick<EngineInterface, 'state'>, ph: PlanDiscussPhase, cfg: PhaseModels): Promise<string> {
  if (ph !== 'discuss' && ph !== 'edit') return ''
  const ov = await read($, modelOverrides)
  return (ov[ph] ?? cfg[ph]).trim()
}

async function runModelCommand($: Pick<EngineInterface, 'ui' | 'command'>, name: string): Promise<void> {
  const res = await $.command.run({ command: 'model', args: name }).catch((err: unknown) => ({ error: String(err) }))
  if ('error' in res) $.ui.toast(`plan-discuss: 모델을 ${name}(으)로 바꾸지 못했습니다 (${res.error}). /model ${name} 을 직접 실행하세요.`)
}

/**
 * 단계에 맞춰 세션 모델을 맞춘다. 바꿔야 할 게 있으면 그 작업(아직 실행 전)을 돌려준다.
 * command.run 훅 안에서는 $.command.run이 거부되므로, 호출한 쪽이 타이머나 프롬프트 전송 앞에서 실행한다.
 */
async function syncModel($: Engine$, ph: PlanDiscussPhase, cfg: PhaseModels): Promise<(() => Promise<void>) | null> {
  const desired = await modelFor($, ph, cfg)
  const applied = await read($, appliedModel)
  if (desired !== '') {
    if (applied === desired) return null
    if (applied === null) {
      const current = await $.session.model()
      await update($, savedModel, () => current)
    }
    await update($, appliedModel, () => desired)
    return () => runModelCommand($, desired)
  }
  if (applied === null) return null
  const back = await read($, savedModel)
  await update($, appliedModel, () => null)
  await update($, savedModel, () => null)
  return back ? () => runModelCommand($, back) : null
}

/** 단계를 바꾸고 모델을 맞춘다. schedule=false면 모델 전환 작업을 돌려주고 실행은 호출한 쪽에 맡긴다 */
async function setPhase(
  $: Engine$,
  next: PlanDiscussPhase,
  cfg: PhaseModels,
  schedule = true,
): Promise<(() => Promise<void>) | null> {
  await update($, phase, () => next)
  await update($, isHidden, () => false)
  await showStatus($)
  const switchModel = await syncModel($, next, cfg)
  if (switchModel && schedule) {
    void $.clock.after(50, switchModel)
    return null
  }
  return switchModel
}

type ShowPlan = 'full' | 'summary' | 'off'

/** 토론 모드로 들어갈 때 모델이 대화창에 계획서를 어떻게 보여줄지 */
function presentPlanInstruction(show: ShowPlan, file: string | null): string {
  const where = file ? ` (${file})` : ''
  if (show === 'full') {
    return [
      `Then show the user the plan: print the whole plan file${where} verbatim in the chat as markdown, so the user can read it without opening the file.`,
      'Do not paraphrase or shorten it, and do not add commentary before it beyond one heading line.',
    ].join(' ')
  }
  if (show === 'summary') {
    return [
      `Then show the user how the plan was put together, in the chat: the goal, the approach you chose and why (including alternatives you rejected),`,
      'the steps in order with the files each one touches, and any open questions or risks. Keep it structured with short headings or bullets.',
    ].join(' ')
  }
  return ''
}

async function readPlanText($: Pick<EngineInterface, 'fs'>, file: string | null): Promise<string | null> {
  if (!file) return null
  try {
    const text = await $.fs.read(file)
    return text.trim() === '' ? null : text.trimEnd()
  } catch {
    return null
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/** 계획서 파일을 다시 읽어 패널에 반영한다 */
async function refreshPlan($: Pick<EngineInterface, 'fs' | 'state'>): Promise<void> {
  const text = await readPlanText($, await read($, planFile))
  await update($, planText, () => text)
}

async function openPlanPane($: Pick<EngineInterface, 'fs' | 'state' | 'ui'>): Promise<boolean> {
  await refreshPlan($)
  const name = (await read($, planFile))?.split(/[\\/]/).pop()
  const opened = await $.ui.open({ id: PLAN_PANE, title: name ? `계획서 · ${name}` : '계획서' })
  return opened.isPlaced
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

// command.run 훅 안에서 바로 $.prompt.submit을 부르면 프롬프트가 턴을 열지 못하고 사라진다.
// 명령이 끝난 뒤 타이머에서 보내고, 그래도 들어가지 않으면 입력창에 채워 Enter만 누르게 한다.
function submitAfterCommand(
  $: Pick<EngineInterface, 'clock' | 'prompt' | 'ui'>,
  text: string,
  before: (() => Promise<void>) | null = null,
): void {
  void $.clock.after(50, async () => {
    if (before) await before()
    const res = await $.prompt.submit({ text, asUser: true }).catch((err: unknown) => ({ drop: String(err) }))
    if (res.drop !== undefined) {
      await $.prompt.fill({ text })
      $.ui.toast(`plan-discuss: 프롬프트가 자동으로 들어가지 않았습니다 (${res.drop}). 입력창에서 Enter를 누르세요.`)
    }
  })
}

export const register: Register = (on, options) => {
  const approveMode = String(options.approveMode ?? 'auto')
  const interceptExit = options.interceptExit !== false
  const showPlanRaw = String(options.showPlan ?? 'full')
  const models: PhaseModels = {
    discuss: String(options.discussModel ?? ''),
    edit: String(options.editModel ?? ''),
  }
  const showPlan: ShowPlan = showPlanRaw === 'summary' || showPlanRaw === 'off' ? showPlanRaw : 'full'
  const planPane = options.planPane !== false

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
        name: 'plan-model',
        description: '토론/수정 단계에서 쓸 모델 선택. 예: /plan-model sonnet · /plan-model edit opus · /plan-model off',
        argumentHint: '[discuss|edit] <모델|off>',
      }),
      $.command.register({
        name: 'plan-go',
        description: `계획 승인: ExitPlanMode 후 ${approveMode === 'dialog' ? '승인 다이얼로그' : approveMode + ' 모드'}로 구현 시작`,
        argumentHint: '[추가 지시]',
      }),
      $.command.register({
        name: 'plan-view',
        description: '계획서를 옆 패널로 열기 (열려 있으면 닫기)',
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
    await setPhase($, 'discuss', models)
    const head = '💬 계획 토론 모드. 계획서에 대해 자유롭게 질문하세요. 계획서는 수정되지 않습니다. 수정은 /plan-edit, 승인은 /plan-go.'
    const file = await read($, planFile)
    // 패널에 계획서가 보이면 대화창에 전문을 다시 찍지 않는다
    if (planPane && (await openPlanPane($))) return { text: `${head}\n계획서는 옆 패널에 열었습니다 (/plan-view로 닫기).` }
    const plan = showPlan === 'off' ? null : await readPlanText($, file)
    if (plan === null) return { text: head }
    return { text: `${head}\n\n--- 계획서 (${file}) ---\n${plan}` }
  })

  on('command.run', { command: 'plan-edit' }, async ($, e) => {
    if (!(await read($, inPlan))) {
      return { text: 'plan-discuss: 지금은 plan 모드가 아닙니다.' }
    }
    const instruction = e.args.trim()
    if (instruction === '') {
      await update($, returnToDiscuss, () => false)
      await setPhase($, 'edit', models)
      return { text: '✎ 계획 수정 모드. 이제 하는 말은 계획서 수정 지시로 처리됩니다. 토론으로 돌아가려면 /plan-talk.' }
    }
    await update($, returnToDiscuss, () => true)
    const switchModel = await setPhase($, 'edit', models, false)
    submitAfterCommand($, editPrompt(instruction), switchModel)
    return { text: '✎ 계획서를 한 번 수정하고 토론 모드로 돌아옵니다.' }
  })

  on('command.run', { command: 'plan-model' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const ph = await read($, phase)
    const ov = await read($, modelOverrides)
    const line = (k: 'discuss' | 'edit') => {
      const v = ov[k] ?? models[k]
      return `${k === 'discuss' ? '토론' : '수정'}: ${v.trim() === '' ? '(세션 모델 그대로)' : v}${ov[k] !== null ? ' (세션에서 지정)' : ''}`
    }
    if (words.length === 0) {
      return { text: `plan-discuss 모델 · ${line('discuss')} · ${line('edit')}\n바꾸려면 /plan-model [discuss|edit] <모델|off>` }
    }
    let target: 'discuss' | 'edit' = ph === 'edit' ? 'edit' : 'discuss'
    if (words[0] === 'discuss' || words[0] === 'edit') target = words.shift() as 'discuss' | 'edit'
    const name = words.join(' ')
    if (name === '') return { text: 'plan-discuss: 모델 이름을 적어주세요. 예: /plan-model sonnet' }
    const value = name === 'off' || name === '-' ? null : name
    await update($, modelOverrides, prev => ({ ...prev, [target]: value }))
    const label = target === 'discuss' ? '토론' : '수정'
    if (!(await read($, inPlan)) || ph !== target) {
      return { text: `plan-discuss: ${label} 단계 모델을 ${value ?? '(설정값)'}(으)로 기억했습니다. 그 단계에 들어가면 적용됩니다.` }
    }
    const switchModel = await syncModel($, ph, models)
    if (switchModel) void $.clock.after(50, switchModel)
    return { text: `plan-discuss: ${label} 단계 모델 → ${value ?? '(설정값)'}. 지금 적용합니다.` }
  })

  on('command.run', { command: 'plan-go' }, async ($, e) => {
    if (!(await read($, inPlan))) {
      return { text: 'plan-discuss: 지금은 plan 모드가 아닙니다.' }
    }
    await update($, returnToDiscuss, () => false)
    const switchModel = await setPhase($, 'approved', models, false)
    submitAfterCommand($, approvePrompt(e.args), switchModel)
    const how = approveMode === 'dialog' ? '승인 다이얼로그가 뜹니다' : `${approveMode} 모드로 전환되어 구현이 시작됩니다`
    return { text: `▶ 계획 승인. ExitPlanMode 후 ${how}.` }
  })

  on('command.run', { command: 'plan-view' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PLAN_PANE)) {
      await $.ui.close({ id: PLAN_PANE })
      return { text: 'plan-discuss: 계획서 패널을 닫았습니다.' }
    }
    if ((await read($, planFile)) === null) {
      return { text: 'plan-discuss: 아직 계획서 파일을 모릅니다. plan 모드에서 계획서가 작성된 뒤에 쓰세요.' }
    }
    await openPlanPane($)
    return { text: 'plan-discuss: 계획서를 패널에 열었습니다.' }
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
      await setPhase($, 'off', models)
    }
    return next(e)
  })

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError === undefined) {
      await update($, inPlan, () => true)
      await update($, returnToDiscuss, () => false)
      await setPhase($, 'off', models)
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
      await setPhase($, 'discuss', models)
      $.ui.toast('💬 계획서 작성 완료 · 토론 모드. 질문하세요. 승인은 /plan-go')
      const where = file ? ` at ${file}` : ''
      const isInPane = planPane && (await openPlanPane($))
      const present = isInPane
        ? 'The plan is already shown to the user in a side pane, so do NOT print it in the chat; at most name its main sections in one line.'
        : presentPlanInstruction(showPlan, file)
      return {
        deny: [
          `plan-discuss: the plan is NOT approved yet, and the user wants to review and discuss it before approving.`,
          `Do NOT call ExitPlanMode again, and do not edit the plan file further in this turn.`,
          `End your turn now, in the user's language: say in one line that the plan is written${where} and ready for discussion.`,
          present,
          `Finish by telling the user they can ask questions about it, run /plan-edit <instruction> to have it revised, or /plan-go to approve it and start implementation.`,
        ].filter(Boolean).join(' '),
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === undefined) {
      await update($, inPlan, () => false)
      await update($, returnToDiscuss, () => false)
      await setPhase($, 'off', models)
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

  // 계획서가 수정되면 패널을 다시 그린다
  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const file = await read($, planFile)
    if (file && 'file_path' in e && samePath(String(e.file_path), file)) await refreshPlan($).catch(() => {})
    return ran
  })

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
    const context = [...(e.context ?? [])]
    if (await read($, userEditedPlan)) {
      await update($, userEditedPlan, () => false)
      context.push(USER_EDITED_CONTEXT)
    }
    if (ph === 'discuss') context.push(DISCUSS_CONTEXT)
    if (ph === 'edit') context.push(EDIT_CONTEXT)
    return context.length === (e.context ?? []).length ? next(e) : next({ ...e, context })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, returnToDiscuss))) {
      await update($, returnToDiscuss, () => false)
      if (await read($, inPlan)) await setPhase($, 'discuss', models)
    }
    return next(e)
  })

  // ---- the plan pane ----------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PLAN_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    const [text, file, editing, isIn] = await Promise.all([
      read($, planText),
      read($, planFile),
      read($, isEditingPlan),
      read($, inPlan),
    ])
    if (text === null || file === null) {
      return <Text dimColor>{file ? `계획서를 읽을 수 없습니다: ${file}` : '아직 계획서가 없습니다.'}</Text>
    }

    // 편집 칸과 수정 지시 칸은 Input이 있는 화면에서만 (모바일은 읽기 전용)
    if (!('Input' in els)) return <Markdown text={text} />
    const { Input } = els

    if (editing) {
      const rows = Math.max(3, e.props.scroll.bodyRows - 3)
      return (
        <Box flexDirection="column">
          <Box>
            <Text color="planMode" bold>✎ 직접 편집 </Text>
            <Text dimColor>Enter 저장 · Shift+Enter 줄바꿈 · </Text>
            <Button key="cancel" label="취소" onPress={() => update($, isEditingPlan, () => false)} />
          </Box>
          <Input
            key="plan-text"
            value={text}
            rows={rows}
            submitLabel="저장"
            autoFocus
            onSubmit={async value => {
              await $.fs.write(file, value.endsWith('\n') ? value : `${value}\n`)
              await refreshPlan($)
              await update($, isEditingPlan, () => false)
              await update($, userEditedPlan, () => true)
              $.ui.toast('plan-discuss: 계획서를 저장했습니다.')
            }}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="edit-direct" label="직접 편집" onPress={() => update($, isEditingPlan, () => true)} />
          <Button key="reload" label="새로고침" onPress={() => refreshPlan($)} />
        </Box>
        {isIn && (
          <Input
            key="instruction"
            label="수정 지시 "
            placeholder="예: 3단계를 테스트 먼저 쓰는 순서로 바꿔줘"
            submitLabel="AI로 수정"
            onSubmit={async value => {
              if (value.trim() === '') return
              await update($, returnToDiscuss, () => true)
              const switchModel = await setPhase($, 'edit', models, false)
              if (switchModel) await switchModel()
              void $.prompt.submit({ text: editPrompt(value), asUser: true })
            }}
          />
        )}
        <Markdown text={text} />
      </Box>
    )
  })

  // ---- the band above the prompt ---------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [isIn, ph, hidden, file, applied] = await Promise.all([
      read($, inPlan),
      read($, phase),
      read($, isHidden),
      read($, planFile),
      read($, appliedModel),
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
          {applied && <Text dimColor> · 모델 {applied}</Text>}
        </Box>
        <Box>
          {ph !== 'discuss' && (
            <Button
              key="talk"
              label="토론 모드"
              hotkey="t"
              onPress={async () => {
                await update($, returnToDiscuss, () => false)
                await setPhase($, 'discuss', models)
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
                await setPhase($, 'edit', models)
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
                const switchModel = await setPhase($, 'approved', models, false)
                if (switchModel) await switchModel()
                void $.prompt.submit({ text: approvePrompt(''), asUser: true })
              }}
            />
          )}
          <Button key="view" label="계획서 패널" hotkey="p" onPress={() => openPlanPane($)} />
          <Button key="hide" label="숨기기" onPress={() => update($, isHidden, () => true)} />
          <Text dimColor> /plan-talk · /plan-edit [지시] · /plan-go [지시] · /plan-view · /plan-model [모델]</Text>
        </Box>
      </Box>
    )
  })
}
