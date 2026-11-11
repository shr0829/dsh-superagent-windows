// @vitest-environment jsdom
// The memory tab: listing, following a hop, forgetting, and merging.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, find, mount, settle, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('lists durable memories, opens one, follows its hop, and forgets it', async () => {
  await mount()
  await click(zh['tab.memory'])
  expect(server.requests.some(request => request.path === 'memories?limit=30')).toBe(true)
  expect(text()).toContain('链式记忆先存一件事')
  await click(find('链式记忆先存一件事', '.dt-open'))
  expect(server.requests.some(request => request.path === 'memories/mem_a')).toBe(true)
  expect(text()).toContain('第一跳：这条记忆指向下一跳。')
  expect(text()).toContain(zh['memoryKind.note'])
  await click(zh['memory.forget'])
  expect(text()).toContain(zh['memory.forgetBody'].replace('{title}', '链式记忆先存一件事'))
  expect(server.requests.some(request => request.path === 'memories/mem_a/forget')).toBe(false)
  await click(all('.dt-modal button').find(button => button.textContent?.trim() === zh.confirm)!)
  expect(server.requests.some(request => request.path === 'memories/mem_a/forget')).toBe(true)
  expect(tab(zh['tab.memory']).getAttribute('aria-selected')).toBe('true')
  expect(text()).not.toContain('链式记忆先存一件事')
  expect(server.memories.map(item => item.memory_id)).toEqual(['mem_b'])
})

it('filters by a word, then merges the picked memories into one after the confirmation', async () => {
  await mount()
  await click(zh['tab.memory'])
  await type(find(zh['memory.searchPlaceholder'], 'input') as HTMLInputElement, '面板')
  await settle()
  expect(server.requests.some(request => request.path.startsWith('memories?q='))).toBe(true)
  expect(text()).toContain('面板记忆页')
  expect(text()).not.toContain('链式记忆先存一件事')
  await type(find(zh['memory.searchPlaceholder'], 'input') as HTMLInputElement, '')
  await settle()
  await click(all('.dt-list input[type=checkbox]')[0]!)
  await click(all('.dt-list input[type=checkbox]')[1]!)
  await click(all('.dt-filters button').find(button => button.textContent?.includes(zh['memory.merge']))!)
  expect(text()).toContain(zh['memory.mergeBody'].replace('{count}', '2'))
  const confirm = all('.dt-modal button').find(button => button.textContent?.trim() === zh['memory.merge'])!
  await click(confirm)
  expect(server.requests.some(request => request.path === 'memories/merge')).toBe(true)
  expect(text()).toContain(zh['memory.merged'].replace('{count}', '2'))
  // The merge replaced both entries, so the list behind the dialog shows the one memory it left.
  expect(server.memories.map(item => item.memory_id)).toEqual(['mem_a'])
})
