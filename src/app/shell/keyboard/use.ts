import { useActiveElement, useEventListener } from '@vueuse/core'
import { computed } from 'vue'

import { useEditorCommands, useViewportKind } from '@open-pencil/vue'

import { useAIChat } from '@/app/ai/chat/use'
import { useEditorStore } from '@/app/editor/active-store'
import { isTodoEmbed } from '@/app/embed/todo/mode'
import { createKeyboardActions } from '@/app/shell/keyboard/actions'
import { bindEditorClipboard } from '@/app/shell/keyboard/clipboard'
import { isInputElement } from '@/app/shell/keyboard/focus'
import { bindNudgeKeys } from '@/app/shell/keyboard/nudging'
import { registerKeyboardShortcuts } from '@/app/shell/keyboard/registry'
import { openFileDialog } from '@/app/shell/menu/use'
import { closeTab, createHomeTab, activeTab as activeTabRef } from '@/app/tabs'

export function useKeyboard() {
  const { activeTab } = useAIChat()
  const store = useEditorStore()
  const { isMobile } = useViewportKind()
  const { runCommand, setOpacityTarget } = useEditorCommands()
  const activeElement = useActiveElement({ triggerOnRemoval: true })
  const inputFocused = computed(() => isInputElement(activeElement.value))

  const actions = createKeyboardActions({
    store,
    activeTab,
    isMobile,
    runCommand,
    setOpacityTarget
  })

  if (isTodoEmbed)
    useEventListener(
      window,
      'keydown',
      (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey)) return
        if (['KeyS', 'KeyO', 'KeyN', 'KeyT', 'KeyW'].includes(event.code)) {
          event.preventDefault()
          event.stopImmediatePropagation()
          if (event.code === 'KeyS') void store.saveFigFile()
        }
      },
      { capture: true }
    )

  bindEditorClipboard(store)
  bindNudgeKeys(store)

  registerKeyboardShortcuts({
    inputFocused,
    store,
    runCommand,
    actions,
    openFileDialog: () => {
      void openFileDialog()
    },
    closeActiveTab: () => {
      if (activeTabRef.value) void closeTab(activeTabRef.value.id)
    },
    createTab: () => createHomeTab()
  })
}
