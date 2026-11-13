import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mqtt from "mqtt";

/* ------------------------------------------------------------------ */
/*  MQTT configuration                                                */
/* ------------------------------------------------------------------ */
const BROKER_URL = "wss://broker.hivemq.com:8884/mqtt";
const TOPIC_SET = "chopyk/smart_lamp/set";
const TOPIC_STATE = "chopyk/smart_lamp/state";

const LOCK_MS = 1500;
const LDR_MAX = 4095;
const BRIGHTNESS_MAX = 255;
const BRIGHTNESS_MIN = 5;

// ВИПРАВЛЕНО: При зміні Hue надсилаємо і mode: 0, і сам hue
const buildHuePayload = (hue) => ({ mode: 0, hue });
const buildBrightnessPayload = (value) => ({ brightness: value });

const MODES = [
    { id: 0, label: "Static", sub: "HSV colour", icon: "palette" },
    { id: 1, label: "Rainbow", sub: "Colour cycle", icon: "rainbow" },
    { id: 2, label: "Nightlight", sub: "Warm 2700K", icon: "moon" },
    { id: 3, label: "Pulse", sub: "Cyan breathing", icon: "pulse" },
];

const TIMER_PRESETS = [15, 30, 60];
const TABS = [
    { id: "control", label: "Control" },
    { id: "paint", label: "Paint" },
];

const CYAN = "#06b6d4";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
const formatCountdown = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const loadMuted = () => {
    try {
        return localStorage.getItem("lamp_muted") === "1";
    } catch {
        return false;
    }
};

/* ------------------------------------------------------------------ */
/*  Icons                                                             */
/* ------------------------------------------------------------------ */
function Icon({ name, className = "h-6 w-6" }) {
    const common = {
        viewBox: "0 0 24 24",
        className,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
    };
    switch (name) {
        case "power":
            return (
                <svg {...common} strokeWidth={2}>
                    <path d="M12 3v9" />
                    <path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
                </svg>
            );
        case "palette":
            return (
                <svg {...common}>
                    <path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-1.2-1-1.4-1-2.5 0-.9.7-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" />
                    <circle cx="7.5" cy="11" r="1" />
                    <circle cx="10" cy="7" r="1" />
                    <circle cx="15" cy="7.5" r="1" />
                </svg>
            );
        case "rainbow":
            return (
                <svg {...common}>
                    <path d="M3 18a9 9 0 0 1 18 0" />
                    <path d="M7 18a5 5 0 0 1 10 0" />
                </svg>
            );
        case "moon":
            return (
                <svg {...common}>
                    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
                </svg>
            );
        case "pulse":
            return (
                <svg {...common}>
                    <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
                </svg>
            );
        case "sun":
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
            );
        case "bell":
            return (
                <svg {...common}>
                    <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" />
                    <path d="M10 20a2 2 0 0 0 4 0" />
                </svg>
            );
        case "bell-off":
            return (
                <svg {...common}>
                    <path d="M8.7 4.3A6 6 0 0 1 18 9c0 3 .5 4.7 1 5.7" />
                    <path d="M6 9c0 6-2 7-2 7h11" />
                    <path d="M10 20a2 2 0 0 0 4 0" />
                    <path d="M3 3l18 18" />
                </svg>
            );
        default:
            return null;
    }
}

function StatusBadge({ status }) {
    const cfg = {
        online: { text: "Online", dot: "bg-emerald-400", ring: "border-emerald-500/40 text-emerald-300", pulse: true },
        connecting: { text: "Connecting", dot: "bg-amber-400", ring: "border-amber-500/40 text-amber-300", pulse: true },
        offline: { text: "Offline", dot: "bg-rose-500", ring: "border-rose-500/40 text-rose-300", pulse: false },
    }[status];

    return (
        <span className={`inline-flex items-center gap-2 rounded-full border bg-slate-900/60 px-3 py-1 text-xs font-medium backdrop-blur ${cfg.ring}`}>
            <span className="relative flex h-2.5 w-2.5">
                {cfg.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${cfg.dot}`} />}
                <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${cfg.dot}`} />
            </span>
            {cfg.text}
        </span>
    );
}

function Card({ title, children, right }) {
    return (
        <section className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-5 shadow-xl backdrop-blur">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">{title}</h2>
                {right}
            </div>
            {children}
        </section>
    );
}

function TabBar({ tab, onChange }) {
    return (
        <div className="grid grid-cols-2 rounded-xl border border-slate-700/60 bg-slate-900/60 p-1">
            {TABS.map((t) => {
                const active = tab === t.id;
                return (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => onChange(t.id)}
                        className={`rounded-lg py-2 text-sm font-semibold transition-all duration-300 ${active ? "bg-cyan-500/15 text-cyan-300 shadow-[0_0_14px_rgba(6,182,212,0.25)]" : "text-slate-400 hover:text-slate-200"
                            }`}
                    >
                        {t.label}
                    </button>
                );
            })}
        </div>
    );
}

function PaintTab() {
    const leds = Array.from({ length: 24 });
    return (
        <Card title="Paint the Strip" right={<span className="rounded-full border border-slate-600 px-2 py-0.5 text-[10px] uppercase tracking-widest text-slate-400">Soon</span>}>
            <p className="mb-4 text-sm text-slate-400">Here you will be able to colour every LED of the strip by hand and send the pattern to the lamp.</p>
            <div className="grid grid-cols-12 gap-1.5 opacity-50">
                {leds.map((_, i) => (
                    <span key={i} className="aspect-square rounded-full border border-slate-600 bg-slate-800" style={{ background: `hsl(${(i / leds.length) * 360}, 40%, 25%)` }} />
                ))}
            </div>
            <button type="button" disabled className="mt-5 w-full cursor-not-allowed rounded-xl border border-slate-700 bg-slate-800/50 py-3 text-sm font-semibold text-slate-500">
                Send pattern
            </button>
        </Card>
    );
}

export default function App() {
    const [conn, setConn] = useState("connecting");
    const [tab, setTab] = useState("control");
    const [power, setPower] = useState(false);
    const [mode, setMode] = useState(0);
    const [ldr, setLdr] = useState(null);
    const [timerActive, setTimerActive] = useState(false);
    const [timerEndsAt, setTimerEndsAt] = useState(null);
    const [selectedTimer, setSelectedTimer] = useState(null);
    const [hue, setHue] = useState(190);
    const [brightness, setBrightness] = useState(BRIGHTNESS_MAX);
    const [muted, setMuted] = useState(loadMuted);
    const [lastTelemetry, setLastTelemetry] = useState(null);
    const [now, setNow] = useState(Date.now());
    const [toast, setToast] = useState(null);

    const clientRef = useRef(null);
    const locksRef = useRef({});
    const throttleRef = useRef({});
    const toastTimerRef = useRef(null);

    const lockField = useCallback((key, value) => {
        locksRef.current[key] = { value, until: Date.now() + LOCK_MS };
    }, []);

    const isStaleEcho = useCallback((key, incoming) => {
        const lock = locksRef.current[key];
        if (!lock) return false;
        if (Date.now() > lock.until) {
            delete locksRef.current[key];
            return false;
        }
        if (lock.value === incoming) {
            delete locksRef.current[key];
            return false;
        }
        return true;
    }, []);

    const showToast = useCallback((msg) => {
        setToast(msg);
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 2000);
    }, []);

    /* ---------- MQTT lifecycle ---------- */
    useEffect(() => {
        const client = mqtt.connect(BROKER_URL, {
            clientId: `lamp_web_${Math.random().toString(16).slice(2, 10)}`,
            clean: true,
            reconnectPeriod: 3000,
            connectTimeout: 10_000,
        });
        clientRef.current = client;

        client.on("connect", () => {
            setConn("online");
            client.subscribe(TOPIC_STATE, { qos: 0 });
        });
        client.on("reconnect", () => setConn("connecting"));
        client.on("close", () => setConn("offline"));
        client.on("offline", () => setConn("offline"));
        client.on("error", () => setConn("offline"));

        client.on("message", (topic, payload) => {
            if (topic !== TOPIC_STATE) return;
            let data;
            try {
                data = JSON.parse(payload.toString());
            } catch {
                return;
            }
            if (!data || typeof data !== "object") return;

            if (typeof data.state === "boolean" && !isStaleEcho("state", data.state)) {
                setPower(data.state);
            }
            if (Number.isInteger(data.mode) && data.mode >= 0 && data.mode <= 3 && !isStaleEcho("mode", data.mode)) {
                setMode(data.mode);
            }
            if (typeof data.brightness === "number" && data.brightness >= 0 && data.brightness <= BRIGHTNESS_MAX && !isStaleEcho("brightness", data.brightness)) {
                setBrightness(Math.round(data.brightness));
            }
            if (typeof data.hue === "number" && data.hue >= 0 && data.hue <= 360 && !isStaleEcho("hue", data.hue)) {
                setHue(Math.round(data.hue));
            }
            if (typeof data.ldr === "number") {
                setLdr(data.ldr);
            }
            if (typeof data.timer_active === "boolean" && !isStaleEcho("timer_active", data.timer_active)) {
                setTimerActive(data.timer_active);
                if (!data.timer_active) {
                    setTimerEndsAt(null);
                    setSelectedTimer(null);
                }
            }
            setLastTelemetry(Date.now());
        });

        return () => {
            Object.values(throttleRef.current).forEach((t) => clearTimeout(t.timer));
            clearTimeout(toastTimerRef.current);
            client.end(true);
            clientRef.current = null;
        };
    }, [isStaleEcho]);

    useEffect(() => {
        if (!timerEndsAt) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [timerEndsAt]);

    const publish = useCallback(
        (payload) => {
            const client = clientRef.current;
            if (!client || !client.connected) {
                showToast("Not connected to broker");
                return false;
            }
            client.publish(TOPIC_SET, JSON.stringify(payload), { qos: 0 });
            return true;
        },
        [showToast]
    );

    const throttledPublish = useCallback(
        (key, payload, interval = 120) => {
            const slot = (throttleRef.current[key] ||= { last: 0, timer: null });
            const send = () => {
                slot.last = Date.now();
                publish(payload);
            };
            const elapsed = Date.now() - slot.last;
            clearTimeout(slot.timer);
            if (elapsed >= interval) {
                send();
            } else {
                slot.timer = setTimeout(send, interval - elapsed);
            }
        },
        [publish]
    );

    const togglePower = () => {
        const next = !power;
        if (!publish({ state: next })) return;
        lockField("state", next);
        setPower(next);
    };

    const selectMode = (id) => {
        if (!publish({ mode: id })) return;
        lockField("mode", id);
        setMode(id);
    };

    const sendTimer = (minutes) => {
        if (!publish({ timer: minutes })) return;
        if (minutes > 0) {
            lockField("timer_active", true);
            setTimerActive(true);
            setSelectedTimer(minutes);
            setTimerEndsAt(Date.now() + minutes * 60_000);
            setNow(Date.now());
        } else {
            lockField("timer_active", false);
            setTimerActive(false);
            setSelectedTimer(null);
            setTimerEndsAt(null);
        }
    };

    const toggleMute = () => {
        const next = !muted;
        if (!publish({ mute: next })) return;
        setMuted(next);
        try {
            localStorage.setItem("lamp_muted", next ? "1" : "0");
        } catch { }
    };

    const changeHue = (value) => {
        setHue(value);
        setMode(0); // Одразу відображаємо у формати Статики
        lockField("hue", value);
        lockField("mode", 0);
        throttledPublish("hue", buildHuePayload(value));
    };

    const changeBrightness = (value) => {
        setBrightness(value);
        lockField("brightness", value);
        throttledPublish("brightness", buildBrightnessPayload(value));
    };

    const ldrPercent = useMemo(() => {
        if (ldr === null) return null;
        return Math.min(100, Math.max(0, Math.round((ldr / LDR_MAX) * 100)));
    }, [ldr]);

    const brightnessPercent = Math.round((brightness / BRIGHTNESS_MAX) * 100);

    const timerLabel = useMemo(() => {
        if (!timerActive) return "Inactive";
        if (timerEndsAt) return formatCountdown(timerEndsAt - now);
        return "Active";
    }, [timerActive, timerEndsAt, now]);

    const online = conn === "online";
    const hueColor = `hsl(${hue}, 100%, 50%)`;

    return (
        <div className="min-h-screen bg-[#0f172a] text-slate-100 selection:bg-cyan-500/30">
            <style>{`
        .hue-slider, .bright-slider { -webkit-appearance: none; appearance: none; height: 14px; border-radius: 9999px; outline: none; }
        .hue-slider { background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%); }
        .bright-slider { background: linear-gradient(to right, #1e293b, #f8fafc); }
        .hue-slider::-webkit-slider-thumb, .bright-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 28px; height: 28px; border-radius: 9999px;
          background: #0f172a; border: 3px solid #fff; box-shadow: 0 0 14px var(--thumb, #06b6d4); cursor: pointer; transition: transform .15s; }
        .hue-slider::-webkit-slider-thumb:active, .bright-slider::-webkit-slider-thumb:active { transform: scale(1.15); }
        .hue-slider::-moz-range-thumb, .bright-slider::-moz-range-thumb { width: 24px; height: 24px; border-radius: 9999px; background: #0f172a; border: 3px solid #fff;
          box-shadow: 0 0 14px var(--thumb, #06b6d4); cursor: pointer; }
      `}</style>

            <div
                aria-hidden
                className={`pointer-events-none fixed inset-0 transition-opacity duration-700 ${power ? "opacity-100" : "opacity-0"}`}
                style={{
                    background: `radial-gradient(600px circle at 50% 28%, ${CYAN}22, transparent 60%)`,
                }}
            />

            <div className="relative mx-auto flex min-h-screen max-w-md flex-col gap-5 px-4 pb-10 pt-6">
                <header className="flex items-center justify-between">
                    <h1 className="bg-gradient-to-r from-cyan-400 to-emerald-400 bg-clip-text text-xl font-bold tracking-tight text-transparent">
                        Smart LED Lamp
                    </h1>
                    <StatusBadge status={conn} />
                </header>

                <TabBar tab={tab} onChange={setTab} />

                {tab === "control" && (
                    <>
                        <div className="flex flex-col items-center py-2">
                            <button
                                type="button"
                                onClick={togglePower}
                                disabled={!online}
                                aria-pressed={power}
                                aria-label={power ? "Turn lamp off" : "Turn lamp on"}
                                className={`relative flex h-48 w-48 flex-col items-center justify-center rounded-full border-2 transition-all duration-500 ease-out
                  active:scale-95 focus:outline-none focus-visible:ring-4 focus-visible:ring-cyan-400/40 disabled:cursor-not-allowed disabled:opacity-50
                  ${power
                                        ? "border-cyan-300/70 bg-gradient-to-br from-cyan-500/30 to-emerald-500/30 text-cyan-200 shadow-[0_0_70px_10px_rgba(6,182,212,0.45),inset_0_0_40px_rgba(16,185,129,0.35)]"
                                        : "border-slate-600 bg-slate-800/80 text-slate-500 hover:border-slate-500"
                                    }`}
                            >
                                {power && <span className="absolute inset-0 animate-ping rounded-full border border-cyan-400/30 [animation-duration:2.5s]" />}
                                <Icon name="power" className={`h-14 w-14 transition-all duration-500 ${power ? "drop-shadow-[0_0_12px_#06b6d4]" : ""}`} />
                                <span className="mt-2 text-sm font-bold tracking-[0.3em]">{power ? "ON" : "OFF"}</span>
                            </button>
                            <p className="mt-4 h-4 text-xs text-slate-500">
                                {online ? (lastTelemetry ? "Synced with lamp" : "Waiting for lamp telemetry...") : "Controls disabled while offline"}
                            </p>
                        </div>

                        <Card
                            title="Brightness"
                            right={
                                <span className="flex items-center gap-2 text-xs text-slate-400">
                                    <Icon name="sun" className="h-4 w-4" />
                                    {brightnessPercent}%
                                </span>
                            }
                        >
                            <input
                                type="range"
                                min={BRIGHTNESS_MIN}
                                max={BRIGHTNESS_MAX}
                                value={brightness}
                                onChange={(e) => changeBrightness(Number(e.target.value))}
                                disabled={!online}
                                className="bright-slider w-full disabled:opacity-50"
                                style={{ "--thumb": "#f8fafc" }}
                                aria-label="Brightness"
                            />
                        </Card>

                        <Card title="Lighting Mode">
                            <div className="grid grid-cols-2 gap-3">
                                {MODES.map((m) => {
                                    const active = mode === m.id;
                                    return (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => selectMode(m.id)}
                                            disabled={!online}
                                            aria-pressed={active}
                                            className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all duration-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${active
                                                    ? "border-cyan-400 bg-cyan-500/10 shadow-[0_0_20px_rgba(6,182,212,0.35)]"
                                                    : "border-slate-700 bg-slate-800/50 hover:border-slate-500"
                                                }`}
                                        >
                                            <Icon name={m.icon} className={`h-6 w-6 ${active ? "text-cyan-300" : "text-slate-400"}`} />
                                            <span className={`text-sm font-semibold ${active ? "text-cyan-300" : "text-slate-200"}`}>{m.label}</span>
                                            <span className="text-[11px] text-slate-500">{m.sub}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </Card>

                        {mode === 0 && (
                            <Card
                                title="Colour Hue"
                                right={
                                    <span className="flex items-center gap-2 text-xs text-slate-400">
                                        <span className="h-4 w-4 rounded-full border border-white/30" style={{ background: hueColor, boxShadow: `0 0 12px ${hueColor}` }} />
                                        {hue}&deg;
                                    </span>
                                }
                            >
                                <input
                                    type="range"
                                    min={0}
                                    max={360}
                                    value={hue}
                                    onChange={(e) => changeHue(Number(e.target.value))}
                                    disabled={!online}
                                    className="hue-slider w-full disabled:opacity-50"
                                    style={{ "--thumb": hueColor }}
                                    aria-label="Hue"
                                />
                            </Card>
                        )}

                        <Card title="Sleep Timer">
                            <div className="grid grid-cols-4 gap-2">
                                {TIMER_PRESETS.map((min) => {
                                    const active = timerActive && selectedTimer === min;
                                    return (
                                        <button
                                            key={min}
                                            type="button"
                                            onClick={() => sendTimer(min)}
                                            disabled={!online}
                                            className={`rounded-xl border py-3 text-sm font-semibold transition-all duration-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${active
                                                    ? "border-emerald-400 bg-emerald-500/10 text-emerald-300 shadow-[0_0_16px_rgba(16,185,129,0.4)]"
                                                    : "border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-500"
                                                }`}
                                        >
                                            {min}m
                                        </button>
                                    );
                                })}
                                <button
                                    type="button"
                                    onClick={() => sendTimer(0)}
                                    disabled={!online}
                                    className="rounded-xl border border-rose-500/40 bg-rose-500/5 py-3 text-sm font-semibold text-rose-300 transition-all duration-300 hover:bg-rose-500/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Reset
                                </button>
                            </div>
                        </Card>

                        <Card title="Buzzer">
                            <button
                                type="button"
                                onClick={toggleMute}
                                disabled={!online}
                                role="switch"
                                aria-checked={!muted}
                                className="flex w-full items-center justify-between rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3 transition-colors hover:border-slate-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <span className="flex items-center gap-3">
                                    <Icon name={muted ? "bell-off" : "bell"} className={`h-6 w-6 ${muted ? "text-slate-500" : "text-emerald-300"}`} />
                                    <span className="text-left">
                                        <span className="block text-sm font-semibold text-slate-200">Acoustic feedback</span>
                                        <span className="block text-[11px] text-slate-500">{muted ? "Muted" : "Sound enabled"}</span>
                                    </span>
                                </span>
                                <span className={`relative h-6 w-11 rounded-full transition-colors duration-300 ${muted ? "bg-slate-600" : "bg-emerald-500"}`}>
                                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-300 ${muted ? "left-0.5" : "left-[22px]"}`} />
                                </span>
                            </button>
                        </Card>

                        <Card
                            title="Live Telemetry"
                            right={
                                lastTelemetry ? (
                                    <span className="text-[11px] text-slate-500">
                                        updated {new Date(lastTelemetry).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                                    </span>
                                ) : null
                            }
                        >
                            <div className="grid grid-cols-2 gap-3">
                                <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
                                    <p className="text-[11px] uppercase tracking-widest text-slate-500">Light sensor</p>
                                    <p className="mt-1 text-2xl font-bold text-cyan-300">{ldrPercent === null ? "-" : `${ldrPercent}%`}</p>
                                    <p className="text-[11px] text-slate-500">raw {ldr === null ? "-" : ldr}</p>
                                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-700">
                                        <div
                                            className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-700"
                                            style={{ width: `${ldrPercent ?? 0}%` }}
                                        />
                                    </div>
                                </div>

                                <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
                                    <p className="text-[11px] uppercase tracking-widest text-slate-500">Sleep timer</p>
                                    <p className={`mt-1 font-mono text-2xl font-bold ${timerActive ? "text-emerald-300" : "text-slate-500"}`}>{timerLabel}</p>
                                    <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                                        <span className={`h-1.5 w-1.5 rounded-full ${timerActive ? "animate-pulse bg-emerald-400" : "bg-slate-600"}`} />
                                        {timerActive ? "Counting down" : "No timer set"}
                                    </p>
                                </div>
                            </div>
                        </Card>
                    </>
                )}

                {tab === "paint" && <PaintTab />}
            </div>

            <div className={`pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-slate-600 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg transition-all duration-300 ${toast ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
                {toast}
            </div>
        </div>
    );
}