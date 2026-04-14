import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentUserId } from "../lib/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionInstance = any;

const LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "it-IT", label: "Italian" },
  { code: "pt-BR", label: "Portuguese (BR)" },
  { code: "nl-NL", label: "Dutch" },
  { code: "ja-JP", label: "Japanese" },
  { code: "zh-CN", label: "Chinese (Mandarin)" },
  { code: "ar-SA", label: "Arabic" },
];

function storageKey(key: string): string {
  return `jigs:voice:${getCurrentUserId()}:${key}`;
}

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** When provided, the textarea is focused as soon as recording starts so the
   *  browser registers a text-input target and delivers transcription results. */
  inputRef?: React.RefObject<HTMLTextAreaElement>;
}

export function VoiceInput({ onTranscript, disabled, inputRef }: VoiceInputProps) {
  const { t } = useTranslation();
  const [isListening, setIsListening] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(
    () => localStorage.getItem(storageKey("deviceId")) || "",
  );
  const [selectedLang, setSelectedLang] = useState(
    () => localStorage.getItem(storageKey("lang")) || "en-US",
  );

  const recognitionRef = useRef<SpeechRecognitionInstance>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Direct DOM refs for level indicators — updated in the RAF loop to avoid
  // going through React's render cycle, giving true 60fps visual updates.
  const levelBarRef = useRef<HTMLDivElement>(null);
  const dot0Ref = useRef<HTMLDivElement>(null);
  const dot1Ref = useRef<HTMLDivElement>(null);
  const dot2Ref = useRef<HTMLDivElement>(null);

  // Enumerate devices on mount (labels may be empty until permission granted)
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((all) => {
      setDevices(all.filter((d) => d.kind === "audioinput"));
    });
  }, []);

  // Close popup on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  // Persist preferences to localStorage (per user)
  useEffect(() => {
    localStorage.setItem(storageKey("deviceId"), selectedDeviceId);
  }, [selectedDeviceId]);

  useEffect(() => {
    localStorage.setItem(storageKey("lang"), selectedLang);
  }, [selectedLang]);

  // Setup SpeechRecognition once — lang is set before each start() call
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = selectedLang;

    recognition.onresult = (event: SpeechRecognitionInstance) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      onTranscriptRef.current(transcript);
    };

    recognition.onerror = () => {
      setIsListening(false);
      cleanupAudio();
    };
    recognition.onend = () => {
      setIsListening(false);
      cleanupAudio();
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanupAudio() {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    // Reset visual indicators
    if (levelBarRef.current) levelBarRef.current.style.width = "0%";
    if (dot0Ref.current) dot0Ref.current.style.height = "3px";
    if (dot1Ref.current) dot1Ref.current.style.height = "3px";
    if (dot2Ref.current) dot2Ref.current.style.height = "3px";
  }

  const startAudioCapture = useCallback(async () => {
    // Clean up any existing capture first (e.g. device switch while menu is open)
    cleanupAudio();
    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId } }
          : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      // Lower smoothing = faster response; 0.4 is a good balance between
      // smoothness and liveness for a level indicator.
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Re-enumerate — labels become available after permission grant
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput"));

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const level = sum / dataArray.length / 255;

        // Bypass React state — write directly to DOM for true 60fps updates
        if (levelBarRef.current) {
          levelBarRef.current.style.width = `${Math.min(level * 300, 100)}%`;
        }
        const scaled = Math.min(level * 3, 1);
        if (dot0Ref.current) dot0Ref.current.style.height = `${Math.max(3, scaled * 14)}px`;
        if (dot1Ref.current) dot1Ref.current.style.height = `${Math.max(3, scaled * 18)}px`;
        if (dot2Ref.current) dot2Ref.current.style.height = `${Math.max(3, scaled * 12)}px`;

        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // getUserMedia failed — level indicator won't work but speech
      // recognition still works via its own mic access
    }
  }, [selectedDeviceId]);

  // While the settings menu is open, run audio capture so the level meter
  // shows real-time input — lets the user verify the selected mic works
  // before starting a recording. Also restarts when the selected device
  // changes so the meter switches immediately (not just on next recording).
  useEffect(() => {
    if (showMenu && !isListening) {
      startAudioCapture();
      return () => cleanupAudio();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMenu, selectedDeviceId]);

  const toggle = useCallback(async () => {
    if (!recognitionRef.current) return;
    if (isListening) {
      recognitionRef.current.stop();
      cleanupAudio();
      setIsListening(false);
    } else {
      recognitionRef.current.lang = selectedLang;
      // Acquire the selected mic before starting recognition — establishing
      // the getUserMedia stream first may cause Chrome/Safari to route the
      // Speech API to the same device instead of the system default.
      await startAudioCapture();
      // Focus the target textarea so the browser registers a text-input
      // context and reliably delivers transcription results to our handler.
      inputRef?.current?.focus();
      try {
        recognitionRef.current.start();
      } catch {
        cleanupAudio();
        return;
      }
      setIsListening(true);
    }
  }, [isListening, selectedLang, inputRef, startAudioCapture]);

  const supported =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  if (!supported) return null;

  return (
    <div
      className="flex items-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Animated sound-level dots (visible while recording) */}
      {isListening && (
        <div className="flex items-center gap-[3px] h-5 mr-0.5">
          <div ref={dot0Ref} className="w-[3px] bg-blue-500 rounded-full transition-none" style={{ height: "3px" }} />
          <div ref={dot1Ref} className="w-[3px] bg-blue-500 rounded-full transition-none" style={{ height: "3px" }} />
          <div ref={dot2Ref} className="w-[3px] bg-blue-500 rounded-full transition-none" style={{ height: "3px" }} />
        </div>
      )}

      {/* Arrow + mic wrapper */}
      <div className="relative flex items-center" ref={menuRef}>
        {/* Small chevron to open settings popup (appears on hover) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu((v) => !v);
          }}
          className={`flex items-center justify-center transition-all duration-150 text-gray-400 hover:text-gray-600 ${
            isHovered || showMenu
              ? "opacity-100 w-4"
              : "opacity-0 w-0 overflow-hidden"
          }`}
          tabIndex={-1}
          aria-label="Voice settings"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 6.5L5 3.5L8 6.5" />
          </svg>
        </button>

        {/* Mic icon */}
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${
            isListening
              ? "text-blue-500 hover:text-blue-600"
              : "text-gray-400 hover:text-gray-600"
          } disabled:opacity-50`}
          title={isListening ? t("voice.stopRecording") : t("voice.startInput")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        </button>

        {/* Settings popup */}
        {showMenu && (
          <div className="absolute bottom-full right-0 mb-2 w-64 bg-white rounded-xl shadow-lg border border-gray-200 p-3 space-y-3 z-50">
            {/* Sound level meter */}
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1.5">
                Input Level
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  ref={levelBarRef}
                  className="h-full bg-blue-500 rounded-full"
                  style={{ width: "0%", transition: "none" }}
                />
              </div>
            </div>

            {/* Mic device picker */}
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1.5">
                Microphone
              </div>
              <div className="space-y-0.5">
                {devices.length === 0 && (
                  <p className="text-xs text-gray-400 italic">
                    No microphones found
                  </p>
                )}
                {devices.map((d, i) => (
                  <label
                    key={d.deviceId}
                    className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer hover:bg-gray-50 rounded px-1.5 py-1"
                  >
                    <input
                      type="radio"
                      name="mic-device"
                      checked={
                        selectedDeviceId
                          ? d.deviceId === selectedDeviceId
                          : i === 0
                      }
                      onChange={() => setSelectedDeviceId(d.deviceId)}
                      className="accent-blue-500"
                    />
                    <span className="truncate">
                      {d.label || `Microphone ${i + 1}`}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Language picker */}
            <div>
              <div className="text-xs font-medium text-gray-500 mb-1.5">
                Language
              </div>
              <div className="space-y-0.5 max-h-36 overflow-y-auto">
                {LANGUAGES.map((lang) => (
                  <label
                    key={lang.code}
                    className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer hover:bg-gray-50 rounded px-1.5 py-1"
                  >
                    <input
                      type="radio"
                      name="voice-lang"
                      checked={lang.code === selectedLang}
                      onChange={() => setSelectedLang(lang.code)}
                      className="accent-blue-500"
                    />
                    {lang.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
