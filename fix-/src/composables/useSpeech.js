import { reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { synthesizeSpeech } from '@/api/tts'

/**
 * 全局单例语音播报器（聊天朗读 + 检修跟读共用）。
 *
 * 全站同一时刻只有一个在播：点 B 朗读会先停掉 A。组件用 id 标识"是不是我这条在播/在加载"，
 * 据此切换「朗读 / 加载中 / 停止」图标。
 *
 * 用法：
 *   const { state, speak, stop, isSpeaking, isLoading } = useSpeech()
 *   speak('msg-12', '要读的文字', { onEnded: () => next() })  // onEnded 供跟读推进
 *   stop()
 *
 * - state.speakingId / loadingId：当前在播 / 在合成的 id（null 表示空闲）
 * - 切换朗读对象时，中止上一条仍在合成中的请求（AbortController），避免旧音频迟到乱入
 */

// —— 模块级单例：跨组件共享同一个播放器与状态 ——
const state = reactive({ speakingId: null, loadingId: null })
let audio = null
let objectUrl = null
let abortController = null

function revokeUrl() {
  if (objectUrl) {
    try { URL.revokeObjectURL(objectUrl) } catch (e) { /* ignore */ }
    objectUrl = null
  }
}

/** 停止当前播放 + 中止在途合成请求，回到空闲态。 */
function stop() {
  if (abortController) {
    try { abortController.abort() } catch (e) { /* ignore */ }
    abortController = null
  }
  if (audio) {
    try { audio.pause() } catch (e) { /* ignore */ }
    audio.onended = null
    audio.onerror = null
    audio = null
  }
  revokeUrl()
  state.speakingId = null
  state.loadingId = null
}

/**
 * 朗读一段文字。
 * @param {string|number} id 调用方唯一标识（消息 id / 步骤 index）
 * @param {string} text 要朗读的文字
 * @param {{ onEnded?: Function }} [opts] onEnded：本条自然播完时回调（跟读靠它推进）
 */
async function speak(id, text, opts = {}) {
  // 再次点击正在播的同一条 → 当作停止
  if (state.speakingId === id) {
    stop()
    return
  }
  if (!text || !text.trim()) {
    return
  }

  stop() // 先停旧的（含中止旧请求）

  const controller = new AbortController()
  abortController = controller
  state.loadingId = id

  let blob
  try {
    blob = await synthesizeSpeech(text, controller.signal)
  } catch (e) {
    // 主动切换导致的中止：静默；其它失败给友好提示
    if (e && e.name === 'AbortError') return
    if (state.loadingId === id) state.loadingId = null
    ElMessage.error('语音服务暂不可用')
    return
  }

  // 合成期间用户已切换/停止 → 丢弃这次结果
  if (abortController !== controller) return
  state.loadingId = null

  revokeUrl()
  objectUrl = URL.createObjectURL(blob)
  audio = new Audio(objectUrl)
  audio.onended = () => {
    if (state.speakingId === id) state.speakingId = null
    revokeUrl()
    if (typeof opts.onEnded === 'function') opts.onEnded()
  }
  audio.onerror = () => {
    if (state.speakingId === id) state.speakingId = null
    revokeUrl()
    ElMessage.error('音频播放失败')
  }
  state.speakingId = id
  try {
    await audio.play()
  } catch (e) {
    // 播放被拒（极少：非用户手势触发）
    if (state.speakingId === id) state.speakingId = null
  }
}

export function useSpeech() {
  return {
    state,
    speak,
    stop,
    isSpeaking: (id) => state.speakingId === id,
    isLoading: (id) => state.loadingId === id,
  }
}
