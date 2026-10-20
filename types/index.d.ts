/** 계획 토론 mod의 단계: off(일반 plan 모드) · discuss(질문/검토만) · edit(계획서 수정 허용) · approved(승인, ExitPlanMode 허용) */
export type PlanDiscussPhase = 'off' | 'discuss' | 'edit' | 'approved'

declare module 'claude-code' {
  interface PluginState {
    'plan-discuss': {
      phase: PlanDiscussPhase
      inPlan: boolean
      planFile: string | null
      returnToDiscuss: boolean
      isHidden: boolean
    }
  }
}
