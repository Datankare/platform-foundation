"use client";

import { useState, useRef, useCallback } from "react";
import { Translation } from "@/types";
import { canSubmitText, getCharState, canClearText } from "@/lib/inputValidation";
import { adminCall } from "@/components/admin/ui/admin-call";
import { AppealLink, offersAppeal } from "@/components/refusal/RefusalNotice";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { languageName } from "@/components/language-name";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const msg = (key: string, values?: MessageValues) =>
  renderMessage(`screens.app.spike.${key}`, values);

const MAX_CHARS = 100;
/** How many characters left before the count is announced (SF-app-018). */
export const NEAR_LIMIT = 10;

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

/**
 * Play a base64 MP3 clip. Whatever stops it — the browser's error, or `play()` refused (autoplay
 * blocked, no audio device: it rejects) — calls `onFail` once, so the screen says so and the
 * button is free again (SF-app-021: a refused play was not caught, and the playing state stuck).
 */
export function startClip(
  base64: string,
  on: { readonly onEnd: () => void; readonly onFail: () => void }
): HTMLAudioElement {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "audio/mp3" });
  const audio = new Audio(URL.createObjectURL(blob));
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    on.onFail();
  };
  audio.onended = on.onEnd;
  audio.onerror = fail;
  void Promise.resolve()
    .then(() => audio.play())
    .catch(fail);
  return audio;
}

export interface SpikeAppProps {
  /** A guest has no account: a rejection offers no appeal (TASK-210). */
  readonly isGuest?: boolean;
}

export default function SpikeApp({ isGuest = false }: SpikeAppProps = {}) {
  const [text, setText] = useState("");
  // The shown error is a moderation decision the user can appeal (content.rejected, a restricted
  // account): the alert links to the account page, where it is appealed (TASK-210, N-117).
  const [appealable, setAppealable] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [error, setErrorText] = useState("");
  // Any other error (or none) is not one: the link goes with the decision's own message.
  const setError = useCallback((message: string) => {
    setErrorText(message);
    setAppealable(false);
  }, []);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([]);

  const { charsLeft, isOverLimit } = getCharState(text);
  const canSubmit = canSubmitText(text, isLoading);
  const canClear = canClearText(text, isLoading);

  const startRecording = useCallback(() => {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      setError(msg("voice_input_is_not_supported"));
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      setText(transcript.slice(0, MAX_CHARS));
      setIsRecording(false);
    };

    recognition.onerror = () => {
      setIsRecording(false);
      setError(msg("voice_recognition_failed_please_try"));
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
    setError("");
  }, [setError]);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  const handleClear = () => {
    setText("");
    setError("");
    setTranslations([]);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setIsLoading(true);
    setError("");
    setTranslations([]);

    // The one call path (components/admin/ui/admin-call.ts): a refusal is shown by its code,
    // through the shared handler (TASK-181; TASK-194 added auth.permission_denied — the feature
    // permission); no answer at all is the network sentence; it never throws.
    const answer = await adminCall("/api/process", {
      method: "POST",
      json: { text: text.trim() },
    });
    setIsLoading(false);
    if (!answer.ok) {
      setError(answer.refusal.message);
      setAppealable(!isGuest && offersAppeal(answer.refusal));
      return;
    }
    // The server's own text is never shown: the catalogue's sentence is (SF-app-020).
    if (answer.body.success !== true) {
      setError(msg("something_went_wrong"));
    } else {
      setTranslations(
        Array.isArray(answer.body.translations)
          ? (answer.body.translations as Translation[])
          : []
      );
    }
  };

  const playAudio = (base64: string, index: number) => {
    audioRefs.current.forEach((audio) => {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    });

    const audio = startClip(base64, {
      onEnd: () => setPlayingIndex(null),
      onFail: () => {
        setPlayingIndex(null);
        setError(msg("audio_playback_failed"));
      },
    });
    audioRefs.current[index] = audio;
    setPlayingIndex(index);
  };

  return (
    // Inside the app's frame (components/app/ui/AppShell.tsx), which holds the page's one main
    // landmark: this is a section of it.
    <section aria-labelledby="spike-title" className="flex justify-center">
      <div className="w-full max-w-xl">
        <div className="text-center mb-8">
          <h1
            id="spike-title"
            className="text-4xl font-bold text-white tracking-tight mb-1"
          >
            {msg("brand_first")}
            <span className="text-blue-400">{msg("brand_second")}</span>
          </h1>
        </div>

        <div className="bg-slate-800/60 backdrop-blur border border-slate-700 rounded-2xl p-6 mb-4 shadow-xl">
          <div className="relative mb-4">
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSubmit) handleSubmit();
                }
              }}
              placeholder={msg("type_something_or_use_voice")}
              rows={3}
              aria-label={msg("text_input")}
              aria-describedby={isOverLimit ? "char-counter char-status" : "char-counter"}
              className={`w-full bg-slate-900/80 text-white placeholder-slate-500 rounded-xl px-4 py-3 text-base resize-none border focus:outline-none focus:ring-2 transition-all ${
                isOverLimit
                  ? "border-red-500 focus:ring-red-500"
                  : "border-slate-600 focus:ring-blue-500"
              }`}
            />
            {/* The count is shown on every keystroke and announced only near the limit
                (SF-app-018): a live region read on every key talked over the typing. */}
            <span
              id="char-counter"
              className={`absolute bottom-3 right-3 text-xs font-mono ${
                isOverLimit
                  ? "text-red-400 font-bold"
                  : charsLeft <= 20
                    ? "text-amber-400"
                    : "text-slate-400"
              }`}
            >
              {charsLeft}
            </span>
            <span role="status" className="sr-only" data-testid="char-announcement">
              {charsLeft <= NEAR_LIMIT && !isOverLimit
                ? msg("characters_left", { count: charsLeft })
                : ""}
            </span>
          </div>

          {isOverLimit && (
            <p
              id="char-status"
              role="alert"
              aria-live="assertive"
              className="text-red-400 text-xs mb-3 text-center font-medium"
            >
              {msg("too_long_please_shorten_to")}
            </p>
          )}

          {/* Wraps on a phone: the three buttons ran past the card at 390 px (walk, TASK-210). */}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={isRecording ? stopRecording : startRecording}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                isRecording
                  ? "bg-red-500 hover:bg-red-600 text-white focus:ring-red-500 animate-pulse"
                  : "bg-slate-700 hover:bg-slate-600 text-slate-200 focus:ring-slate-500"
              }`}
            >
              <span className="text-lg" aria-hidden="true">
                {isRecording ? "⏹" : "🎤"}
              </span>
              {isRecording ? msg("stop") : msg("speak")}
            </button>

            <button
              onClick={handleClear}
              disabled={!canClear}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                !canClear
                  ? "bg-slate-700 cursor-not-allowed text-slate-500 opacity-40"
                  : "bg-slate-700 hover:bg-slate-500 text-slate-200 focus:ring-slate-500"
              }`}
            >
              <span aria-hidden="true">✕</span>
              {msg("clear")}
            </button>

            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                !canSubmit
                  ? "bg-slate-600 cursor-not-allowed text-slate-400 opacity-50"
                  : "bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
              }`}
            >
              {isLoading ? (
                <>
                  <span className="animate-spin text-lg" aria-hidden="true">
                    ⟳
                  </span>
                  {msg("processing")}
                </>
              ) : (
                <>
                  <span aria-hidden="true">▶</span>
                  {msg("translate_and_speak")}
                </>
              )}
            </button>
          </div>

          <p className="text-slate-400 text-xs mt-3 text-center">
            {msg("max_characters_suitable", { max: MAX_CHARS })}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="bg-red-900/40 border border-red-700 text-red-300 rounded-xl px-4 py-3 mb-4 text-sm"
          >
            <p>{error}</p>
            {appealable && <AppealLink />}
          </div>
        )}

        {translations.length > 0 && (
          <div
            aria-label={msg("translation_results")}
            aria-live="polite"
            className="space-y-3"
          >
            {translations.map((t, i) => (
              <div
                key={t.languageCode}
                className="bg-slate-800/60 backdrop-blur border border-slate-700 rounded-2xl px-5 py-4 flex items-center gap-4 shadow-lg"
              >
                <div className="flex-shrink-0 text-center w-14">
                  <div className="text-2xl" aria-hidden="true">
                    {t.flag}
                  </div>
                  <div className="text-slate-400 text-xs mt-0.5">
                    {languageName(t.languageCode, t.language)}
                  </div>
                </div>
                <p
                  lang={t.languageCode}
                  className="flex-1 text-white text-base leading-relaxed"
                >
                  {t.text}
                </p>
                <button
                  onClick={() => playAudio(t.audioBase64, i)}
                  aria-label={msg("play_language_audio", {
                    language: languageName(t.languageCode, t.language),
                  })}
                  disabled={playingIndex !== null && playingIndex !== i}
                  className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                    playingIndex === i
                      ? "bg-blue-500 text-white animate-pulse"
                      : "bg-slate-700 hover:bg-blue-700 text-slate-200 disabled:opacity-40"
                  }`}
                >
                  <span aria-hidden="true">{playingIndex === i ? "♪" : "🔊"}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
