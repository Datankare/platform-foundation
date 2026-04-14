"use client";

import { useState, useRef, useCallback } from "react";
import { Translation } from "@/types";
import { canSubmitText, getCharState, canClearText } from "@/lib/inputValidation";

const MAX_CHARS = 100;

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

export default function SpikeApp() {
  const [text, setText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [error, setError] = useState("");
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
      setError(
        "Voice input is not supported in this browser. Please use Chrome or Edge."
      );
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
      setError("Voice recognition failed. Please try again or type your input.");
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
    setError("");
  }, []);

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

    try {
      const response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error || "Something went wrong.");
      } else {
        setTranslations(data.translations || []);
      }
    } catch {
      /* justified */
      // API error — shown to user via setError
      setError("Network error. Please check your connection and try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const playAudio = (base64: string, index: number) => {
    audioRefs.current.forEach((audio) => {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    });

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "audio/mp3" });
    const audio = new Audio(URL.createObjectURL(blob));
    audioRefs.current[index] = audio;
    setPlayingIndex(index);

    audio.onended = () => setPlayingIndex(null);
    audio.onerror = () => {
      setPlayingIndex(null);
      setError("Audio playback failed.");
    };
    audio.play();
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-xl">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white tracking-tight mb-1">
            PLAY<span className="text-blue-400">FORM</span>
          </h1>
          <p className="text-slate-400 text-sm tracking-widest uppercase">
            Platform Validation Spike · v0.1
          </p>
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
              placeholder="Type something or use voice input..."
              rows={3}
              aria-label="Text input"
              aria-describedby="char-counter char-status"
              className={`w-full bg-slate-900/80 text-white placeholder-slate-500 rounded-xl px-4 py-3 text-base resize-none border focus:outline-none focus:ring-2 transition-all ${
                isOverLimit
                  ? "border-red-500 focus:ring-red-500"
                  : "border-slate-600 focus:ring-blue-500"
              }`}
            />
            <span
              id="char-counter"
              aria-live="polite"
              className={`absolute bottom-3 right-3 text-xs font-mono ${
                isOverLimit
                  ? "text-red-400 font-bold"
                  : charsLeft <= 20
                    ? "text-amber-400"
                    : "text-slate-500"
              }`}
            >
              {charsLeft}
            </span>
          </div>

          {isOverLimit && (
            <p
              id="char-status"
              role="alert"
              aria-live="assertive"
              className="text-red-400 text-xs mb-3 text-center font-medium"
            >
              ✗ Too long — please shorten to 100 characters or fewer
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={isRecording ? stopRecording : startRecording}
              aria-label={isRecording ? "Stop recording" : "Start voice input"}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                isRecording
                  ? "bg-red-500 hover:bg-red-600 text-white focus:ring-red-500 animate-pulse"
                  : "bg-slate-700 hover:bg-slate-600 text-slate-200 focus:ring-slate-500"
              }`}
            >
              <span className="text-lg" aria-hidden="true">
                {isRecording ? "⏹" : "🎤"}
              </span>
              {isRecording ? "Stop" : "Speak"}
            </button>

            <button
              onClick={handleClear}
              disabled={!canClear}
              aria-label="Clear input"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                !canClear
                  ? "bg-slate-700 cursor-not-allowed text-slate-500 opacity-40"
                  : "bg-slate-700 hover:bg-slate-500 text-slate-200 focus:ring-slate-500"
              }`}
            >
              <span aria-hidden="true">✕</span>
              Clear
            </button>

            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-label="Submit and translate"
              aria-disabled={!canSubmit}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                !canSubmit
                  ? "bg-slate-600 cursor-not-allowed text-slate-400 opacity-50"
                  : "bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
              }`}
            >
              {isLoading ? (
                <>
                  <span className="animate-spin text-lg" aria-hidden="true">
                    ⟳
                  </span>
                  Processing...
                </>
              ) : (
                <>
                  <span aria-hidden="true">▶</span>
                  Translate &amp; Speak
                </>
              )}
            </button>
          </div>

          <p className="text-slate-500 text-xs mt-3 text-center">
            Max 100 characters · SFW content only · Press Enter to submit
          </p>
        </div>

        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="bg-red-900/40 border border-red-700 text-red-300 rounded-xl px-4 py-3 mb-4 text-sm"
          >
            {error}
          </div>
        )}

        {translations.length > 0 && (
          <div aria-label="Translation results" aria-live="polite" className="space-y-3">
            {translations.map((t, i) => (
              <div
                key={t.languageCode}
                className="bg-slate-800/60 backdrop-blur border border-slate-700 rounded-2xl px-5 py-4 flex items-center gap-4 shadow-lg"
              >
                <div className="flex-shrink-0 text-center w-14">
                  <div className="text-2xl" aria-hidden="true">
                    {t.flag}
                  </div>
                  <div className="text-slate-500 text-xs mt-0.5">{t.language}</div>
                </div>
                <p
                  lang={t.languageCode}
                  className="flex-1 text-white text-base leading-relaxed"
                >
                  {t.text}
                </p>
                <button
                  onClick={() => playAudio(t.audioBase64, i)}
                  aria-label={`Play ${t.language} audio`}
                  disabled={playingIndex !== null && playingIndex !== i}
                  className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${
                    playingIndex === i
                      ? "bg-blue-500 text-white animate-pulse"
                      : "bg-slate-700 hover:bg-blue-600 text-slate-200 disabled:opacity-40"
                  }`}
                >
                  <span aria-hidden="true">{playingIndex === i ? "♪" : "🔊"}</span>
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-slate-600 text-xs mt-8">
          Platform Foundation · Foundation as Fabric · Continuous Confidence
        </p>
      </div>
    </main>
  );
}
