/**
 * A fake `speechSynthesis` for *Read aloud* tests (#5745). The test DOM has none, which is also
 * what keeps *Read aloud* hidden, and asking no IPC, in every other suite.
 *
 * `speak` records the utterance and speaks nothing; the test ends it with `endCurrent()` or fails
 * it with `failCurrent(error)`, as the engine's `end` / `error` would. `cancel` reports the
 * utterance it cuts as `interrupted`, as Chromium does. Undo with `vi.unstubAllGlobals()`.
 */

import { vi } from 'vitest'

export class FakeUtterance extends EventTarget {
  readonly text: string
  constructor(text: string) {
    super()
    this.text = text
  }

  /** The engine finished speaking it. */
  end(): void {
    this.dispatchEvent(new Event('end'))
  }

  fail(error: string): void {
    this.dispatchEvent(Object.assign(new Event('error'), { error }))
  }
}

export interface FakeSpeech {
  /** Every utterance spoken, in order. */
  readonly spoken: FakeUtterance[]
  readonly cancel: ReturnType<typeof vi.fn>
  endCurrent: () => void
  failCurrent: (error: string) => void
}

export function installFakeSpeech(): FakeSpeech {
  const spoken: FakeUtterance[] = []
  const synth = {
    speak: (utterance: FakeUtterance) => {
      spoken.push(utterance)
    },
    cancel: vi.fn(() => spoken.at(-1)?.fail('interrupted')),
  }
  vi.stubGlobal('speechSynthesis', synth)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  return {
    spoken,
    cancel: synth.cancel,
    endCurrent: () => spoken.at(-1)?.end(),
    failCurrent: (error) => spoken.at(-1)?.fail(error),
  }
}
