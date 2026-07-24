import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture,
  Beef,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Flame,
  Loader2,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Trash2,
  Unplug,
  Upload,
  Usb,
  Utensils,
  Wheat,
  X,
  Zap,
} from "lucide-react";
import logFoodCoach from "@/assets/latspread.png";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, type DetectedItem, type ToolCall, type VisionDebug } from "@/lib/api";
import { useScale } from "@/hooks/use-scale";
import { MOCK_FOOD_DB, scaleFood } from "@/lib/mock-foods";
import {
  sumMacros,
  todayIso,
  useApp,
  type FoodItem,
  type Macros,
  type MealEntry,
} from "@/lib/store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/log-food")({
  head: () => ({
    meta: [
      { title: "Log food — NutriCoach" },
      {
        name: "description",
        content: "Choose a day and time, capture a meal, and confirm your macro log.",
      },
    ],
  }),
  component: LogFood,
});

const uid = () => Math.random().toString(36).slice(2, 10);
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// Auto-capture tuning: a streamed reading counts as "settled" once it stays
// within SETTLE_TOLERANCE_G for SETTLE_WINDOW_MS. Readings below MIN_CAPTURE_G
// are treated as an empty/near-empty plate (noise, or an item being removed) and
// never trigger a capture. SETTLE_RETAIN_MS is how much reading history we keep.
const SETTLE_WINDOW_MS = 700;
const SETTLE_TOLERANCE_G = 2;
const MIN_CAPTURE_G = 5;
const SETTLE_RETAIN_MS = 2000;
const SETTLE_SAMPLE_MS = 80; // how often the auto loop samples the live weight
const DEFAULT_SERVING_G = 30; // fallback serving size when the label/OFF has none
// When there's no scale reading to apply (e.g. a plain photo upload with no hardware),
// we still need a total weight to turn the model's per-100g + fraction ratios into
// concrete macros. This nominal total is what the backend used to assume; now the math
// lives here on the client, the assumption does too — the user can re-weigh to correct it.
const FALLBACK_TOTAL_G = 180;

// A detected food carries its per-100g density and fraction (its share of the plate) so
// it can be re-priced at any weight, plus the source its nutrition came from and (for
// packaged foods) a serving size.
type DetectedFood = FoodItem & {
  confidence?: number;
  per100: Macros;
  fraction: number;
  servingGrams?: number | null;
  trace?: ToolCall[];
};

// Turn the weight-independent detections from the API (per-100g density + fraction) into
// concrete foods at a given total weight — THIS is the "math on the frontend": grams =
// fraction × totalGrams, macros = per100 × grams / 100. The source is carried through so
// the UI can always show where each number came from.
function materialize(items: DetectedItem[], totalGrams: number): DetectedFood[] {
  return items.map((it) => {
    const grams = Math.max(1, Math.round(it.fraction * totalGrams));
    const factor = grams / 100;
    return {
      id: uid(),
      name: it.name,
      grams,
      calories: Math.round(it.per100.calories * factor),
      protein: round(it.per100.protein * factor),
      carbs: round(it.per100.carbs * factor),
      fat: round(it.per100.fat * factor),
      fdcId: it.fdcId ?? null,
      source: it.source,
      confidence: it.confidence,
      per100: it.per100,
      fraction: it.fraction,
      servingGrams: it.servingGrams ?? null,
      trace: it.trace ?? [],
    };
  });
}

// Human-readable provenance for a food's macros, so the UI can state plainly where the
// numbers came from. `tone` drives the badge colour — an AI estimate (the last-resort
// fallback) is flagged amber so it's obviously less trustworthy than a database hit.
function sourceMeta(source?: string | null): {
  label: string;
  tone: "db" | "label" | "estimate" | "manual";
} {
  switch (source) {
    case "openfoodfacts":
      return { label: "Open Food Facts", tone: "db" };
    case "barcode":
      return { label: "Barcode · Open Food Facts", tone: "db" };
    case "usda-fdc":
      return { label: "USDA FoodData Central", tone: "db" };
    case "label":
      return { label: "Nutrition label", tone: "label" };
    case "estimate":
      return { label: "AI estimate", tone: "estimate" };
    case "reference":
      return { label: "Offline reference", tone: "estimate" };
    case "manual":
      return { label: "Manual entry", tone: "manual" };
    default:
      return { label: source ? source : "Detected", tone: "manual" };
  }
}

const SOURCE_TONE_CLASS: Record<ReturnType<typeof sourceMeta>["tone"], string> = {
  db: "bg-green-100 text-green-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  label: "bg-sky-100 text-sky-700 dark:bg-cyan-400/15 dark:text-cyan-300",
  estimate: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  manual: "bg-muted text-muted-foreground",
};

function SourceBadge({ source }: { source?: string | null }) {
  const { label, tone } = sourceMeta(source);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold",
        SOURCE_TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

const TOOL_LABEL: Record<string, string> = {
  openfoodfacts: "Open Food Facts",
  "usda-fdc": "USDA FoodData Central",
  barcode: "Barcode → Open Food Facts",
  label: "Nutrition label OCR",
  estimate: "AI estimate (fallback)",
};

const TRACE_STATUS_CLASS: Record<string, string> = {
  hit: "bg-green-100 text-green-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  used: "bg-sky-100 text-sky-700 dark:bg-cyan-400/15 dark:text-cyan-300",
  miss: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
};

// One tool call: which DB was queried, with what string, and what came back. This is the
// "model called this tool, searched for X, got Y" line the debug view is built around.
function TraceRow({ call }: { call: ToolCall }) {
  const per100 = call.per100 ?? null;
  return (
    <div className="rounded-lg border bg-card/70 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
            TRACE_STATUS_CLASS[call.status] ?? "bg-muted text-muted-foreground",
          )}
        >
          {call.status}
        </span>
        <span className="text-[11px] font-extrabold">{TOOL_LABEL[call.tool] ?? call.tool}</span>
      </div>
      {call.query != null && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          searched <code className="rounded bg-muted px-1 font-mono">{call.query}</code>
          {call.matchedQuery && call.matchedQuery !== call.query && (
            <>
              {" "}
              → matched on{" "}
              <code className="rounded bg-muted px-1 font-mono">{call.matchedQuery}</code>
            </>
          )}
        </div>
      )}
      <div className="mt-0.5 text-[11px]">
        {call.result ? (
          <span className="font-bold text-foreground">→ {call.result}</span>
        ) : (
          <span className="font-bold text-rose-600 dark:text-rose-300">→ no match</span>
        )}
        {call.fdcId != null && (
          <span className="ml-1 text-muted-foreground">(fdc {String(call.fdcId)})</span>
        )}
        {call.cached && <span className="ml-1 text-muted-foreground">· cached</span>}
      </div>
      {per100 && (
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          per 100g: {JSON.stringify(per100)}
        </div>
      )}
    </div>
  );
}

// Collapsible verbose panel: the model's raw reply, the step notes, and each detected
// food's tool-call chain. Purely a debugging aid — hidden behind a <details> so it never
// clutters the normal flow.
function DebugPanel({ debug, items }: { debug: VisionDebug | null; items: DetectedFood[] }) {
  const hasTraces = items.some((it) => (it.trace?.length ?? 0) > 0);
  if (!debug && !hasTraces) return null;
  return (
    <details className="rounded-2xl border border-dashed bg-muted/30 p-3 text-xs">
      <summary className="cursor-pointer font-extrabold">
        🐞 Debug trace{debug?.model ? ` · ${debug.model}` : ""}
      </summary>
      <div className="mt-3 space-y-3">
        {debug?.barcode && (
          <div>
            <span className="font-bold">Barcode:</span>{" "}
            <code className="rounded bg-muted px-1 font-mono">{debug.barcode}</code>
          </div>
        )}
        {items.map(
          (it) =>
            (it.trace?.length ?? 0) > 0 && (
              <div key={it.id} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-extrabold">{it.name}</span>
                  <SourceBadge source={it.source} />
                </div>
                <div className="space-y-1">
                  {it.trace!.map((call, i) => (
                    <TraceRow key={i} call={call} />
                  ))}
                </div>
              </div>
            ),
        )}
        {debug?.notes && debug.notes.length > 0 && (
          <div>
            <div className="mb-1 font-bold">Steps</div>
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {debug.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          </div>
        )}
        {debug?.reasoning && (
          <details className="rounded-lg border bg-card/70 p-2">
            <summary className="cursor-pointer font-bold">Model reasoning</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">
              {debug.reasoning}
            </pre>
          </details>
        )}
        {debug?.modelRaw && (
          <details className="rounded-lg border bg-card/70 p-2">
            <summary className="cursor-pointer font-bold">Model raw response</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">
              {debug.modelRaw}
            </pre>
          </details>
        )}
        {debug?.usage && (
          <div className="font-mono text-[10px] text-muted-foreground">
            usage: {JSON.stringify(debug.usage)}
          </div>
        )}
      </div>
    </details>
  );
}

// A capture paused for the user to choose a portion. The trigger weight is only
// used as the basis for scaling; the logged amount comes from the user's choice.
type PendingCapture = {
  items: DetectedFood[]; // detected foods, absolute macros at the trigger weight
  triggerGrams: number; // capture trigger weight (sum of item grams)
  servingGrams: number | null; // grams per serving from the label/OFF, if known
};

// Grab a JPEG frame from the live <video> for the server-side barcode scanner. 1024px
// on the long edge at q0.85 keeps the bars crisp enough that pyzbar decodes on the
// first clean look (blurry/tiny frames are the main reason a scan needs several tries);
// it's still small to upload on localhost. Returns null until the video has pixels.
async function grabFrame(video: HTMLVideoElement, maxEdge = 1024): Promise<Blob | null> {
  const { videoWidth: w, videoHeight: h } = video;
  if (!w || !h) return null;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

function LogFood() {
  const { user, goals, settings, addMeal, updateMeal, deleteMeal, logs, ready } = useApp();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialDate = useMemo(() => parseIsoDate(todayIso()), []);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const weekStartsOn = settings?.weekStartsOn ?? "monday";
  const [weekStart, setWeekStart] = useState(() => startOfWeek(initialDate, weekStartsOn));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [mealHour, setMealHour] = useState(new Date().getHours().toString().padStart(2, "0"));
  const [mealMinute, setMealMinute] = useState("00");
  // Live reading from the physical HX711 food scale over Web Serial, with a mock
  // fallback so the demo still works with no hardware plugged in.
  const scale = useScale();
  const [mockWeight, setMockWeight] = useState(0);
  const [tareOffset, setTareOffset] = useState(0);
  const [capturedWeight, setCapturedWeight] = useState(0);
  const [scanning, setScanning] = useState(false);
  // Hands-free "auto-capture" loop: tare -> wait for the weight to settle ->
  // snapshot + analyze + add to the meal -> re-tare, ready for the next item.
  const [autoActive, setAutoActive] = useState(false);
  // True after a capture while we wait for the item to be lifted off the plate —
  // drives the "remove the item" prompt. Mirrors rearmNeededRef, but as state so
  // the UI re-renders (the ref alone doesn't).
  const [awaitingRemoval, setAwaitingRemoval] = useState(false);
  // A capture paused for a portion decision (log by serving vs re-weigh).
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | null>(null);
  const [reweighing, setReweighing] = useState(false); // waiting for a fresh weight
  const [servingSize, setServingSize] = useState(String(DEFAULT_SERVING_G));
  const [servingCount, setServingCount] = useState("1");
  const readingsRef = useRef<{ t: number; w: number }[]>([]); // rolling settle window
  const autoBusyRef = useRef(false); // a capture->add->tare cycle is in flight
  const rearmNeededRef = useRef(false); // wait for an empty plate before re-arming
  const latestWeightRef = useRef<number | null>(null); // newest reading, for the poll loop
  const pendingCaptureRef = useRef<PendingCapture | null>(null); // mirror, for the poll loop
  const reweighingRef = useRef(false); // mirror, for the poll loop
  // Live webcam capture
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Guards a getUserMedia call that's in flight so we never open two streams for
  // the same webcam (StrictMode double-mounts, or a fast double click) — opening
  // twice and stopping one corrupts the survivor into a black feed.
  const acquiringRef = useRef(false);
  // Deferred camera teardown handle; see the auto-start effect below.
  const teardownRef = useRef<number | null>(null);
  // Live barcode auto-scan bookkeeping. `last` de-dupes repeat toasts for an unmatched
  // code; `weight` lets the scan loop (which only re-subscribes on cameraOn) read fresh
  // grams without restarting.
  const lastBarcodeRef = useRef<string | null>(null);
  const weightRef = useRef(0);
  const [detected, setDetected] = useState<FoodItem[]>([]);
  const [mealItems, setMealItems] = useState<FoodItem[]>([]);
  const [visionProvider, setVisionProvider] = useState<string | null>(null);
  const [visionDebug, setVisionDebug] = useState<VisionDebug | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingFoodId, setRemovingFoodId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  useEffect(
    () => () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    },
    [imagePreview],
  );

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setWeekStart(startOfWeek(parseIsoDate(selectedDate), weekStartsOn));
  }, [selectedDate, weekStartsOn]);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  };

  const startCamera = async () => {
    // Already live (e.g. auto-started on mount) — just show it; opening a second
    // stream for the same webcam corrupts the feed into a black frame.
    if (streamRef.current) {
      setCameraOn(true);
      return;
    }
    if (acquiringRef.current) return; // a start is already in flight
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Camera not supported", {
        description: "Your browser can't access a webcam. Upload an image instead.",
      });
      return;
    }
    acquiringRef.current = true;
    setCameraStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      // The <video> mounts on the next render; a useEffect attaches the stream
      // once the element is actually in the DOM (see below).
      setCameraOn(true);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Camera permission denied. Allow access or upload an image."
          : "Could not start the camera. Try uploading an image instead.";
      toast.error(message);
    } finally {
      acquiringRef.current = false;
      setCameraStarting(false);
    }
  };

  // Grab the current webcam frame as a JPEG File, or null if the camera isn't
  // ready. Shared by the manual "Capture photo" button and the auto-capture loop.
  const snapshotFrame = async (): Promise<File | null> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) return null;
    return new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });
  };

  const capturePhoto = async () => {
    const file = await snapshotFrame();
    if (!file) {
      toast.error("Camera isn't ready yet — give it a second.");
      return;
    }
    // Keep the camera streaming so the user can grab another angle without
    // re-opening it — the feed stays live the whole session.
    await captureImage(file);
  };

  // Bind the live stream the instant the <video> mounts. A *stable* callback ref
  // fires the moment the element is committed to the DOM — so when the dialog
  // opens and the <video> appears, the already-running stream attaches
  // immediately, instead of waiting on an effect to catch up (the case that
  // showed a black frame on first open). `useCallback([])` keeps it stable so
  // React doesn't detach/reattach on every render.
  const attachStream = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    const play = () => void video.play().catch(() => undefined);
    if (video.readyState >= 2) play();
    else video.onloadedmetadata = play;
  }, []);

  // Fallback attach for when the stream arrives *after* the <video> is already
  // mounted (e.g. the manual "Open camera" button while the dialog is open) —
  // the callback ref above won't re-fire for an element that's already there.
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!cameraOn || !video || !stream) return;
    video.srcObject = stream;
    const play = () => void video.play().catch(() => undefined);
    if (video.readyState >= 2) play();
    else video.onloadedmetadata = play;
    return () => {
      video.onloadedmetadata = null;
    };
    // `editorOpen` re-runs this when the dialog (which hosts the <video>) opens,
    // re-binding the already-live stream to the freshly mounted element.
  }, [cameraOn, editorOpen]);

  // Start the camera automatically on arrival so the feed is live without a
  // click, and release it when leaving the page.
  //
  // React StrictMode double-invokes this effect in dev (mount → cleanup →
  // mount). The `acquiringRef` guard in startCamera means the second mount never
  // opens a competing stream, and the teardown is deferred to a macrotask: the
  // synchronous remount cancels it, so only a *real* unmount actually stops the
  // camera. This avoids the black-feed race from acquiring twice.
  useEffect(() => {
    if (teardownRef.current !== null) {
      clearTimeout(teardownRef.current);
      teardownRef.current = null;
    }
    void startCamera();
    return () => {
      teardownRef.current = window.setTimeout(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setCameraOn(false);
        teardownRef.current = null;
      }, 0);
    };
  }, []);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart],
  );
  const mealTime = `${normalizeTimePart(mealHour, 23)}:${normalizeTimePart(mealMinute, 59)}`;
  // Hardware weight (already hardware-tared) when a scale is connected, otherwise the
  // mock value. `tareOffset` is a software fallback for demo mode; `capturedWeight`
  // freezes a reading (>0) for the analysis call.
  const liveWeight = Math.max(0, (scale.connected ? (scale.weight ?? 0) : mockWeight) - tareOffset);
  const displayedWeight = capturedWeight > 0 ? capturedWeight : liveWeight;
  // Keep the barcode scan loop (subscribed only on cameraOn) reading the latest weight.
  weightRef.current = displayedWeight;
  const selectedDay = logs.find((day) => day.date === selectedDate);
  const mealTotals = useMemo(
    () => sumMacros([{ id: "draft", time: mealTime, items: mealItems }]),
    [mealItems, mealTime],
  );
  const dayTotals = useMemo(() => sumMacros(selectedDay?.meals ?? []), [selectedDay]);
  const filteredFoods = useMemo(() => {
    const query = search.trim().toLowerCase();
    return MOCK_FOOD_DB.filter((food) => !query || food.name.toLowerCase().includes(query)).slice(
      0,
      7,
    );
  }, [search]);

  const chooseDate = (date: Date) => {
    setSelectedDate(toIsoDate(date));
    setWeekStart(startOfWeek(date, weekStartsOn));
    setCalendarOpen(false);
  };

  const shiftWeek = (days: number) => {
    const nextDate = addDays(parseIsoDate(selectedDate), days);
    setSelectedDate(toIsoDate(nextDate));
    setWeekStart(startOfWeek(nextDate, weekStartsOn));
  };

  const openLogEditor = (hour: number) => {
    setMealHour(hour.toString().padStart(2, "0"));
    setMealMinute("00");
    setEditorOpen(true);
  };

  // Tare the scale and arm the hands-free loop. Shared by "Log now" and the
  // in-dialog "Start auto-capture" button.
  const armAutoCapture = async () => {
    readingsRef.current = [];
    rearmNeededRef.current = false;
    autoBusyRef.current = false;
    setAwaitingRemoval(false);
    setPendingCapture(null);
    setReweighing(false);
    setCapturedWeight(0);
    await scale.tare();
    setAutoActive(true);
  };

  const stopAutoCapture = () => {
    setAutoActive(false);
    readingsRef.current = [];
    autoBusyRef.current = false;
    rearmNeededRef.current = false;
    setAwaitingRemoval(false);
    setPendingCapture(null);
    setReweighing(false);
  };

  const openLogNow = async () => {
    const now = new Date();
    const today = todayIso();
    setSelectedDate(today);
    setWeekStart(startOfWeek(parseIsoDate(today), weekStartsOn));
    setMealHour(now.getHours().toString().padStart(2, "0"));
    setMealMinute(now.getMinutes().toString().padStart(2, "0"));
    setEditorOpen(true);
    if (scale.connected) {
      await armAutoCapture();
      toast.success("Scale tared — place your first item", {
        description: "Auto-capture on: snap each item, then remove it to log the next.",
      });
    } else {
      toast("Connect the scale for hands-free auto-capture", {
        description: "Without a scale, capture photos manually below.",
      });
    }
  };

  const removeLoggedFood = async (meal: MealEntry, foodId: string) => {
    setRemovingFoodId(foodId);
    try {
      if (meal.items.length === 1) {
        await deleteMeal(meal.id);
        toast.success("Food and empty meal removed");
      } else {
        await updateMeal(selectedDate, {
          ...meal,
          items: meal.items.filter((item) => item.id !== foodId),
        });
        toast.success("Logged food removed");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that food");
    } finally {
      setRemovingFoodId(null);
    }
  };

  const connectScale = async () => {
    if (!scale.supported) {
      toast.error("Web Serial not supported", {
        description: "Use Chrome or Edge to connect the food scale.",
      });
      return;
    }
    const ok = await scale.connect();
    if (ok) {
      toast.success("Scale connected!", { description: "Live weight is streaming in." });
    }
  };

  // Demo-only helper: fakes a platform reading when no hardware is connected.
  const simulateScale = () => {
    const reading = Math.round(60 + Math.random() * 340);
    setMockWeight(reading + tareOffset);
    toast("Scale reading updated", { description: `${reading}g on the platform.` });
  };

  const tare = async () => {
    setCapturedWeight(0);
    if (scale.connected) {
      await scale.tare(); // zero the load cell on the hardware
    } else {
      setTareOffset(mockWeight);
    }
    // Re-sync the auto-capture loop to the new zero: drop buffered readings and
    // re-arm from this baseline. Without this, a manual tare mid-loop leaves the
    // rearm/readings state pointing at the old baseline and captures stop firing.
    // (Leave autoBusyRef alone so we never race an in-flight capture.)
    readingsRef.current = [];
    rearmNeededRef.current = false;
    setAwaitingRemoval(false);
    toast.success("Scale tared to 0g");
  };

  const captureWeight = () => {
    if (liveWeight <= 0) {
      toast.error("Place food on the scale or create a reading first.");
      return;
    }
    setCapturedWeight(liveWeight);
    toast.success("Weight captured", { description: `${liveWeight}g will guide detection.` });
  };

  // Run the food-vision cascade on a frame and return the raw weight-independent
  // detections (per-100g + fraction), or null on error. No weight is sent — the caller
  // applies a total weight via materialize(). Shared by manual capture and the auto loop.
  const analyzeImage = async (file: File): Promise<DetectedItem[] | null> => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
    setScanning(true);
    try {
      // The server cascade decodes any barcode in the frame (pyzbar) before the model,
      // so a captured/uploaded barcode photo already resolves to the exact product.
      const result = await api.analyze(file);
      setVisionProvider(result.provider);
      setVisionDebug(result.debug ?? null);
      return result.items;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not analyze that image");
      return null;
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // The total weight to price a manual capture at: the captured/live scale reading when
  // there is one, else the nominal fallback (the user can re-weigh to correct it).
  const captureTotalGrams = () => {
    const w = capturedWeight || displayedWeight;
    return w > 0 ? w : FALLBACK_TOTAL_G;
  };

  const captureImage = async (file: File) => {
    const raw = await analyzeImage(file);
    if (!raw) return;
    const items = materialize(raw, captureTotalGrams());
    setDetected(items);
    toast.success(`Found ${items.length} food${items.length === 1 ? "" : "s"}`, {
      description: "Review portions before adding them to the meal.",
    });
  };

  // Scale a batch of detected foods (priced at `fromGrams` total) to a new total
  // weight, preserving each food's share. Linear in grams, so this works for both
  // "log by serving" and "weigh again".
  const scaleDetected = (items: DetectedFood[], fromGrams: number, toGrams: number): FoodItem[] => {
    const factor = fromGrams > 0 ? toGrams / fromGrams : 1;
    return items.map((it) => ({
      id: uid(),
      name: it.name,
      grams: Math.max(1, Math.round(it.grams * factor)),
      calories: Math.round(it.calories * factor),
      protein: round(it.protein * factor),
      carbs: round(it.carbs * factor),
      fat: round(it.fat * factor),
      fdcId: it.fdcId,
      source: it.source,
    }));
  };

  // Commit a paused capture at `totalGrams`, then wait for the item to be lifted
  // off before arming the next capture.
  const commitPending = (pend: PendingCapture, totalGrams: number) => {
    const scaled = scaleDetected(pend.items, pend.triggerGrams, totalGrams);
    setMealItems((current) => [...current, ...scaled]);
    toast.success(
      `Added ${scaled.length} food${scaled.length === 1 ? "" : "s"} · ${Math.round(totalGrams)}g — remove it for the next`,
    );
    setPendingCapture(null);
    setReweighing(false);
    setCapturedWeight(0);
    rearmNeededRef.current = true; // wait for the plate to be cleared before re-arming
    readingsRef.current = [];
    setAwaitingRemoval(true);
  };

  // "Log by serving size": price the capture at servingSize × servingCount.
  const logByServing = () => {
    if (!pendingCapture) return;
    const sizeG = Math.max(1, parseFloat(servingSize) || 0);
    const count = Math.max(0.1, parseFloat(servingCount) || 1);
    commitPending(pendingCapture, sizeG * count);
  };

  // "Weigh the food again": keep the identity, zero the scale, and wait for a
  // fresh settled weight (handled in the poll loop's re-weigh branch).
  const weighAgain = async () => {
    if (!pendingCapture) return;
    readingsRef.current = [];
    setReweighing(true);
    await scale.tare();
    toast("Place the food on the scale", {
      description: "We'll log it automatically once the weight settles.",
    });
  };

  // Discard a paused capture without logging; wait for removal before re-arming.
  const cancelPending = () => {
    setPendingCapture(null);
    setReweighing(false);
    rearmNeededRef.current = true;
    readingsRef.current = [];
    setAwaitingRemoval(true);
  };

  // One turn of the hands-free loop: snapshot the plate and analyze it. The
  // settled weight is only the capture *trigger* — we pause on a pending decision
  // (log by serving / weigh again) rather than logging the trigger weight.
  const runAutoCapture = async (grams: number) => {
    try {
      const file = await snapshotFrame();
      if (!file) {
        toast.error("Camera isn't ready — remove the item and try again.");
        rearmNeededRef.current = true;
        readingsRef.current = [];
        setAwaitingRemoval(true);
        return;
      }
      const raw = await analyzeImage(file);
      if (!raw || !raw.length) {
        toast.error("No food detected — remove the item and try again.");
        rearmNeededRef.current = true;
        readingsRef.current = [];
        setAwaitingRemoval(true);
        return;
      }
      // The settled scale reading IS the total weight; price the detections at it here.
      const items = materialize(raw, grams);
      const triggerGrams = grams;
      const servingGrams = raw.find((it) => it.servingGrams != null)?.servingGrams ?? null;
      setPendingCapture({ items, triggerGrams, servingGrams });
      setServingSize(String(servingGrams ?? DEFAULT_SERVING_G));
      setServingCount("1");
      toast.success("Food identified — choose how to log it");
    } finally {
      autoBusyRef.current = false;
    }
  };

  // Log a re-weighed capture at a freshly settled weight. Called from the poll loop.
  const finalizeReweigh = (grams: number) => {
    const pend = pendingCaptureRef.current;
    if (!pend) {
      setReweighing(false);
      autoBusyRef.current = false;
      return;
    }
    commitPending(pend, grams);
    autoBusyRef.current = false;
  };

  // Keep live refs so the settle effect calls the latest closures without
  // re-subscribing on every render.
  const runAutoCaptureRef = useRef(runAutoCapture);
  runAutoCaptureRef.current = runAutoCapture;
  const finalizeReweighRef = useRef(finalizeReweigh);
  finalizeReweighRef.current = finalizeReweigh;
  // Mirror latest reading + loop state into refs so the polling loop reads current
  // values even when React skips re-renders (identical state bails out).
  latestWeightRef.current = scale.weight;
  pendingCaptureRef.current = pendingCapture;
  reweighingRef.current = reweighing;

  // Settle detection: watch the streamed weight and fire one auto-capture once a
  // reading has held steady for a full window.
  //
  // We *poll* on a fixed cadence rather than reacting to weight changes: the hook
  // calls setWeight() every reading, but React bails on identical values, so the
  // instant a reading stabilizes it stops emitting — an event-driven check would
  // never see "settled" and capture would only fire on random jitter (the "takes
  // way longer than the window" bug). Sampling on a timer makes it deterministic:
  // a steady plate captures ~SETTLE_WINDOW_MS after it stops changing.
  useEffect(() => {
    if (!autoActive || !scale.connected) {
      readingsRef.current = [];
      return;
    }
    const tick = () => {
      const w = latestWeightRef.current;
      if (w == null) return;
      const now = Date.now();
      const buf = readingsRef.current;
      buf.push({ t: now, w });
      while (buf.length > 1 && now - buf[0].t > SETTLE_RETAIN_MS) buf.shift();

      if (autoBusyRef.current) return; // a capture cycle is already running

      // Is the reading loaded (>= MIN) and steady across the whole window?
      let settled = false;
      if (w >= MIN_CAPTURE_G) {
        const windowStart = now - SETTLE_WINDOW_MS;
        if (buf[0].t <= windowStart) {
          // full window of history
          let min = Infinity;
          let max = -Infinity;
          for (const r of buf) {
            if (r.t < windowStart) continue;
            if (r.w < min) min = r.w;
            if (r.w > max) max = r.w;
          }
          settled = max - min <= SETTLE_TOLERANCE_G;
        }
      }

      // Re-weigh mode: the food is already identified; log it at the fresh weight.
      if (reweighingRef.current) {
        if (settled) {
          autoBusyRef.current = true;
          finalizeReweighRef.current(w);
        }
        return;
      }

      // Paused on a portion decision — don't trigger anything until the user picks.
      if (pendingCaptureRef.current) return;

      // After a capture, wait for the item to be removed (plate reads empty)
      // before arming again, then re-zero on the empty plate so any drift is
      // cancelled before the next item.
      if (rearmNeededRef.current) {
        if (w < MIN_CAPTURE_G) {
          rearmNeededRef.current = false;
          setAwaitingRemoval(false);
          void scale.tare();
        }
        return;
      }

      if (settled) {
        autoBusyRef.current = true; // claim the cycle before the async work starts
        void runAutoCaptureRef.current(w);
      }
    };
    const id = window.setInterval(tick, SETTLE_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [autoActive, scale.connected]);

  // Auto mode only makes sense with a live scale and an open editor; drop out of
  // it if the scale disconnects or the dialog closes.
  useEffect(() => {
    if (autoActive && (!scale.connected || !editorOpen)) {
      setAutoActive(false);
      setPendingCapture(null);
      setReweighing(false);
    }
  }, [autoActive, scale.connected, editorOpen]);

  // While the camera is live, continuously scan for a barcode: grab a frame, POST it to
  // the pyzbar decode endpoint, and fire the NEXT frame the moment that one returns (a
  // self-scheduling loop, not a fixed timer) so the effective rate is capped only by the
  // round-trip — snappy on localhost. The instant a barcode resolves to a product we
  // stop the camera and load it, no capture press. Works everywhere (server-side decode).
  useEffect(() => {
    if (!cameraOn) return;
    lastBarcodeRef.current = null;
    let cancelled = false;
    let timer: number | undefined;

    const scanOnce = async () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && video.videoWidth) {
        try {
          const frame = await grabFrame(video);
          if (!cancelled && frame) {
            const res = await api.scanBarcodeFrame(frame);
            if (cancelled) return;
            if (res.status === "matched" && res.result) {
              stopCamera(); // flips cameraOn -> this effect's cleanup halts the loop
              // Price the matched product at the live scale weight (or the fallback).
              const total = weightRef.current > 0 ? weightRef.current : FALLBACK_TOTAL_G;
              const items = materialize(res.result.items, total);
              setDetected(items);
              setVisionProvider(res.result.provider);
              setVisionDebug(res.result.debug ?? null);
              toast.success(`Barcode matched: ${items[0]?.name ?? res.barcode}`, {
                description: "Review the portion before adding it to the meal.",
              });
              return; // matched -> stop the loop
            }
            if (res.status === "unmatched" && res.barcode !== lastBarcodeRef.current) {
              // Read a code, but it isn't in Open Food Facts. Note it once and keep
              // scanning — the user can reposition or snap a photo for the model instead.
              lastBarcodeRef.current = res.barcode;
              toast.error(`Barcode ${res.barcode} isn't in the food database.`, {
                description: "Try another angle, or capture a photo to analyze it.",
              });
            }
          }
        } catch {
          // Network hiccup -> ignore and try the next frame.
        }
      }
      // Tiny gap keeps the loop from busy-spinning if the video isn't ready yet.
      if (!cancelled) timer = window.setTimeout(scanOnce, 120);
    };
    void scanOnce();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [cameraOn]);

  const addReferenceFood = (food: (typeof MOCK_FOOD_DB)[number]) => {
    const grams = capturedWeight > 0 ? capturedWeight : 100;
    setMealItems((current) => [
      ...current,
      { id: uid(), name: food.name, grams, ...scaleFood(food.per100, grams), source: "manual" },
    ]);
    toast.success(`${food.name} added to this meal`);
  };

  const resizeItem = (
    collection: FoodItem[],
    setCollection: React.Dispatch<React.SetStateAction<FoodItem[]>>,
    id: string,
    grams: number,
  ) => {
    setCollection(
      collection.map((item) => {
        if (item.id !== id) return item;
        const safeGrams = Math.max(1, grams);
        const ratio = safeGrams / item.grams;
        return {
          ...item,
          grams: safeGrams,
          calories: Math.round(item.calories * ratio),
          protein: round(item.protein * ratio),
          carbs: round(item.carbs * ratio),
          fat: round(item.fat * ratio),
        };
      }),
    );
  };

  const addDetectedToMeal = () => {
    if (!detected.length) return;
    setMealItems((current) => [...current, ...detected]);
    setDetected([]);
    setCapturedWeight(0);
    setMockWeight(0);
    setTareOffset(0);
    toast.success("Detected foods added to this meal");
  };

  const saveMeal = async () => {
    if (!mealItems.length) return;
    setSaving(true);
    try {
      await addMeal(selectedDate, { id: uid(), time: mealTime, items: mealItems });
      toast.success("Meal confirmed and saved", {
        description: "Your timeline, dashboard, and coach are now updated.",
      });
      setMealItems([]);
      setEditorOpen(false);
      setImagePreview(null);
      setCapturedWeight(0);
      setMockWeight(0);
      setTareOffset(0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the meal");
    } finally {
      setSaving(false);
    }
  };

  // Live preview for the "log by serving" choice.
  const servingTotalG =
    Math.max(1, parseFloat(servingSize) || 0) * Math.max(0.1, parseFloat(servingCount) || 1);
  const servingPreviewCals =
    pendingCapture && pendingCapture.triggerGrams > 0
      ? Math.round(
          pendingCapture.items.reduce((sum, it) => sum + it.calories, 0) *
            (servingTotalG / pendingCapture.triggerGrams),
        )
      : 0;

  if (!goals) return null;

  return (
    <AppLayout>
      <div className="space-y-5">
        <header className="flex items-center gap-4">
          <img
            src={logFoodCoach}
            alt="NutriCoach ready to help log food"
            className="h-20 w-16 shrink-0 object-contain object-bottom"
          />
          <div>
            <div className="text-sm font-semibold text-primary">Log food</div>
            <h1 className="text-2xl font-black md:text-3xl">Your food timeline</h1>
            <p className="text-sm text-muted-foreground">
              Pick a day and log food at the time you ate it.
            </p>
          </div>
        </header>

        <WeekBar
          days={weekDays}
          selectedDate={selectedDate}
          onSelect={chooseDate}
          onPrevious={() => shiftWeek(-7)}
          onNext={() => shiftWeek(7)}
          calendarOpen={calendarOpen}
          onCalendarOpenChange={setCalendarOpen}
          weekStartsOn={weekStartsOn}
        />

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="card-soft overflow-hidden">
            <div className="flex items-center justify-between border-b bg-card px-5 py-4">
              <div>
                <div className="text-xs font-extrabold uppercase tracking-wider text-primary">
                  Daily timeline
                </div>
                <h2 className="mt-0.5 text-xl font-black">{formatLongDate(selectedDate)}</h2>
              </div>
              <span className="rounded-full bg-primary/8 px-3 py-1 text-xs font-bold text-primary">
                {selectedDay?.meals.reduce((count, meal) => count + meal.items.length, 0) ?? 0}{" "}
                foods logged
              </span>
            </div>

            <div className="divide-y">
              {HOURS.map((hour, index) => {
                const meals =
                  selectedDay?.meals.filter(
                    (meal) => Number.parseInt(meal.time.split(":")[0] ?? "0", 10) === hour,
                  ) ?? [];
                return (
                  <TimelineRow
                    key={hour}
                    hour={hour}
                    meals={meals}
                    first={index === 0}
                    last={index === HOURS.length - 1}
                    onLog={() => openLogEditor(hour)}
                    onRemoveFood={(meal, foodId) => void removeLoggedFood(meal, foodId)}
                    removingFoodId={removingFoodId}
                  />
                );
              })}
            </div>
          </section>

          <aside className="space-y-5 self-start xl:sticky xl:top-5">
            <section className="rounded-2xl border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-card text-primary shadow-sm">
                  <Clock3 className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-extrabold uppercase tracking-wider text-primary">
                    Quick log
                  </div>
                  <div className="text-lg font-black">Log food now</div>
                </div>
                <div className="shrink-0 border-l pl-4 text-right">
                  <div className="text-[10px] font-extrabold uppercase tracking-wider text-muted-foreground">
                    Current time
                  </div>
                  <time
                    className="text-xl font-black tabular-nums"
                    dateTime={currentTime.toISOString()}
                  >
                    {formatCurrentTime(currentTime)}
                  </time>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                Open the food scanner using today’s date and the current hour and minute.
              </p>
              <Button
                onClick={() => void openLogNow()}
                className="mt-4 w-full rounded-xl font-extrabold"
              >
                <Plus className="mr-2 h-4 w-4" /> Log now
              </Button>
            </section>
            <MacroPanel totals={dayTotals} goals={goals} />
            <section className="rounded-2xl border border-dashed bg-primary/5 p-5">
              <div className="text-sm font-extrabold">Ready to log?</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Press + Log beside any hour. Food selection, review, and confirmation all happen
                inside that popup.
              </p>
            </section>
          </aside>
        </div>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="flex h-[92vh] max-h-[860px] w-[calc(100%-1rem)] flex-col overflow-hidden rounded-3xl p-0 sm:max-w-[96vw] 2xl:max-w-7xl">
          <DialogHeader className="shrink-0 border-b px-5 py-4 text-left">
            <DialogTitle className="flex items-center gap-2 text-xl">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 text-primary">
                <Plus className="h-4 w-4" />
              </span>
              Log food at {formatTime(mealTime)}
            </DialogTitle>
            <DialogDescription>
              {formatLongDate(selectedDate)} · Scan the plate or add food manually.
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1.05fr)_minmax(300px,0.85fr)_minmax(300px,0.72fr)] lg:grid-rows-1 lg:overflow-hidden">
            <div className="flex min-h-80 flex-col overflow-hidden border-b lg:min-h-0 lg:border-b-0 lg:border-r">
              <div className="flex shrink-0 items-center justify-between px-5 py-3">
                <div>
                  <h3 className="flex items-center gap-2 font-black">
                    <Camera className="h-4 w-4 text-primary" /> Camera food detection
                  </h3>
                  <p className="text-xs text-muted-foreground">Capture your plate for analysis.</p>
                </div>
                <span className="rounded-full bg-primary/8 px-2.5 py-1 text-[10px] font-extrabold uppercase text-primary">
                  {visionProvider ?? "Ready"}
                </span>
              </div>

              <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-slate-950 p-5 text-white">
                {cameraOn ? (
                  <div className="relative z-10 flex w-full flex-col items-center">
                    <div className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-black">
                      <video
                        ref={attachStream}
                        autoPlay
                        playsInline
                        muted
                        className="max-h-[300px] w-full object-contain"
                      />
                      {scanning && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
                          <Loader2 className="h-10 w-10 animate-spin text-sun" />
                          <div className="text-center">
                            <div className="font-extrabold">Identifying your food…</div>
                            <div className="mt-0.5 text-xs text-white/70">
                              Analyzing the plate — this can take a few seconds.
                            </div>
                          </div>
                        </div>
                      )}
                      {awaitingRemoval && !scanning && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/65 backdrop-blur-sm">
                          <span className="grid h-12 w-12 place-items-center rounded-full bg-green-500/20">
                            <Check className="h-7 w-7 text-green-400" />
                          </span>
                          <div className="text-center">
                            <div className="font-extrabold">Logged — remove the item</div>
                            <div className="mt-0.5 text-xs text-white/70">
                              Lift it off the scale; the next item arms automatically.
                            </div>
                          </div>
                        </div>
                      )}
                      {pendingCapture && !scanning && !reweighing && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/65 backdrop-blur-sm">
                          <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/25">
                            <Check className="h-7 w-7 text-primary" />
                          </span>
                          <div className="text-center">
                            <div className="font-extrabold">Food identified</div>
                            <div className="mt-0.5 text-xs text-white/70">
                              Choose a portion on the right — by serving or weigh it.
                            </div>
                          </div>
                        </div>
                      )}
                      {reweighing && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/65 backdrop-blur-sm">
                          <Scale className="h-9 w-9 text-sun" />
                          <div className="text-center">
                            <div className="font-extrabold">Weigh the food</div>
                            <div className="mt-0.5 text-xs text-white/70">
                              Place it on the scale — logs once the weight settles.
                            </div>
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={stopCamera}
                        aria-label="Close camera"
                        className="absolute right-2 top-2 z-30 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <Button
                      onClick={() => void capturePhoto()}
                      disabled={scanning}
                      variant="secondary"
                      className="mt-4 rounded-full font-bold"
                    >
                      {scanning ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…
                        </>
                      ) : (
                        <>
                          <Aperture className="mr-2 h-4 w-4" /> Capture photo
                        </>
                      )}
                    </Button>
                    <div className="mt-2 flex items-center gap-1.5 text-[11px] font-bold text-white/70">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
                      Barcode auto-scan on — hold a label up to log it instantly
                    </div>
                  </div>
                ) : (
                  <>
                    {imagePreview ? (
                      <img
                        src={imagePreview}
                        alt="Meal ready for food detection"
                        className="absolute inset-0 h-full w-full object-cover opacity-70"
                      />
                    ) : (
                      <div className="absolute inset-5 rounded-2xl border border-dashed border-white/25" />
                    )}
                    <div className="relative z-10 text-center">
                      {scanning ? (
                        <>
                          <Loader2 className="mx-auto h-10 w-10 animate-spin text-sun" />
                          <div className="mt-3 font-extrabold">Analyzing your plate…</div>
                        </>
                      ) : (
                        <>
                          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/15 backdrop-blur">
                            <Camera className="h-7 w-7" />
                          </span>
                          <div className="mt-3 font-extrabold">
                            {imagePreview ? "Capture another angle" : "Show your meal"}
                          </div>
                          <div className="mt-1 text-xs text-white/65">
                            Use your webcam or upload an image
                          </div>
                        </>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void captureImage(file);
                        }}
                      />
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        <Button
                          onClick={() => void startCamera()}
                          disabled={scanning || cameraStarting}
                          variant="secondary"
                          className="rounded-full font-bold"
                        >
                          {cameraStarting ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Camera className="mr-2 h-4 w-4" />
                          )}
                          {cameraStarting ? "Starting…" : "Open camera"}
                        </Button>
                        <Button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={scanning}
                          variant="outline"
                          className="rounded-full font-bold bg-slate-800 text-slate-100 border-slate-700 hover:bg-slate-700 hover:text-white"
                        >
                          <Upload className="mr-2 h-4 w-4" /> Upload image
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-4 p-5 lg:min-h-0 lg:overflow-y-auto">
              <section className="rounded-2xl bg-gradient-to-br from-sky/10 to-primary/10 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">
                      <Scale className="h-4 w-4 text-sky-600 dark:text-sky-300" /> Scale display
                    </div>
                    <div className="mt-1 text-4xl font-black tabular-nums">
                      {displayedWeight}
                      <span className="ml-1 text-base text-muted-foreground">g</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs font-bold">
                      <span
                        className={cn(
                          "inline-block h-2 w-2 rounded-full",
                          scale.connected ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
                        )}
                      />
                      <span className={scale.connected ? "text-primary" : "text-muted-foreground"}>
                        {capturedWeight > 0
                          ? `${capturedWeight}g captured`
                          : scale.connected
                            ? "Live scale reading"
                            : "Demo mode — scale not connected"}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void tare()}
                      className="rounded-xl"
                    >
                      Tare
                    </Button>
                    {!scale.connected && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={simulateScale}
                        className="rounded-xl"
                      >
                        <RefreshCw className="mr-1 h-3.5 w-3.5" /> Reading
                      </Button>
                    )}
                  </div>
                </div>
                <Button onClick={captureWeight} className="mt-3 w-full rounded-xl font-bold">
                  <Scale className="mr-2 h-4 w-4" /> Capture weight
                </Button>
                {scale.connected && (
                  <div className="mt-3">
                    {autoActive ? (
                      <div
                        className={cn(
                          "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5",
                          awaitingRemoval && !scanning
                            ? "border-amber-400/50 bg-amber-50 dark:bg-amber-950/40"
                            : "border-primary/30 bg-primary/10",
                        )}
                      >
                        <div
                          className={cn(
                            "flex items-center gap-2 text-xs font-extrabold",
                            awaitingRemoval && !scanning
                              ? "text-amber-700 dark:text-amber-300"
                              : "text-primary",
                          )}
                        >
                          {scanning ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Identifying food…
                            </>
                          ) : reweighing ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Weighing — waiting for it to settle…
                            </>
                          ) : pendingCapture ? (
                            <>
                              <span className="relative flex h-2.5 w-2.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
                              </span>
                              Choose a portion below
                            </>
                          ) : awaitingRemoval ? (
                            <>
                              <Check className="h-3.5 w-3.5" />
                              Logged · remove the item to continue
                            </>
                          ) : (
                            <>
                              <span className="relative flex h-2.5 w-2.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
                              </span>
                              Auto-capturing · place an item
                            </>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={stopAutoCapture}
                          disabled={scanning}
                          className="h-7 rounded-lg px-2 text-xs"
                        >
                          Stop
                        </Button>
                      </div>
                    ) : (
                      <Button
                        onClick={() => {
                          void armAutoCapture();
                          toast.success("Scale tared — place your first item", {
                            description: "Auto-capture on: each settled item is snapped and added.",
                          });
                        }}
                        variant="outline"
                        className="w-full rounded-xl font-bold"
                      >
                        <Zap className="mr-2 h-4 w-4" /> Start auto-capture
                      </Button>
                    )}
                  </div>
                )}
                {scale.supported &&
                  (scale.connected ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void scale.disconnect()}
                      className="mt-2 w-full rounded-xl text-xs"
                    >
                      <Unplug className="mr-1 h-3.5 w-3.5" /> Disconnect scale
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void connectScale()}
                      className="mt-2 w-full rounded-xl text-xs"
                    >
                      <Usb className="mr-1 h-3.5 w-3.5" /> Connect scale
                    </Button>
                  ))}
              </section>

              {pendingCapture && (
                <section className="rounded-2xl border-2 border-primary/40 bg-primary/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-extrabold uppercase tracking-wider text-primary">
                        Identified · choose a portion
                      </div>
                      <h3 className="mt-0.5 truncate text-lg font-black">
                        {pendingCapture.items.map((it) => it.name).join(", ")}
                      </h3>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {[...new Set(pendingCapture.items.map((it) => it.source ?? ""))].map(
                          (src) => (
                            <SourceBadge key={src} source={src} />
                          ),
                        )}
                        <span className="text-xs text-muted-foreground">
                          · captured at {Math.round(pendingCapture.triggerGrams)}g
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={cancelPending}
                      aria-label="Discard capture"
                      className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Option 1 — log by serving size */}
                  <div className="mt-3 rounded-xl border bg-card p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-extrabold">Log by serving size</div>
                      <span className="text-xs font-bold text-muted-foreground">
                        {Math.round(servingTotalG)}g · {servingPreviewCals} kcal
                      </span>
                    </div>
                    {pendingCapture.servingGrams == null && (
                      <div className="mt-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-300">
                        No serving size on the label — enter it below.
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-bold">
                      <div className="flex items-center gap-1 rounded-lg border bg-muted/30 px-2">
                        <Input
                          type="number"
                          min={1}
                          value={servingSize}
                          onChange={(event) => setServingSize(event.target.value)}
                          aria-label="Serving size in grams"
                          className="h-9 w-16 border-0 bg-transparent p-1 text-center font-bold shadow-none"
                        />
                        <span className="text-muted-foreground">g</span>
                      </div>
                      <span className="text-muted-foreground">×</span>
                      <div className="flex items-center gap-1 rounded-lg border bg-muted/30 px-2">
                        <Input
                          type="number"
                          min={0}
                          step="0.5"
                          value={servingCount}
                          onChange={(event) => setServingCount(event.target.value)}
                          aria-label="Number of servings"
                          className="h-9 w-14 border-0 bg-transparent p-1 text-center font-bold shadow-none"
                        />
                        <span className="text-muted-foreground">serv</span>
                      </div>
                    </div>
                    <Button onClick={logByServing} className="mt-2 w-full rounded-xl font-bold">
                      <Check className="mr-2 h-4 w-4" /> Log this serving
                    </Button>
                  </div>

                  {/* Option 2 — weigh the food again */}
                  <div className="mt-2 rounded-xl border bg-card p-3">
                    <div className="text-sm font-extrabold">Weigh the food</div>
                    {reweighing ? (
                      <div className="mt-2 flex items-center gap-2 text-xs font-bold text-primary">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Place it on the scale — logging once the weight settles…
                      </div>
                    ) : (
                      <>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          Zero the scale and weigh the actual portion (e.g. cereal poured out).
                        </div>
                        <Button
                          onClick={() => void weighAgain()}
                          variant="outline"
                          className="mt-2 w-full rounded-xl font-bold"
                        >
                          <Scale className="mr-2 h-4 w-4" /> Weigh it now
                        </Button>
                      </>
                    )}
                  </div>
                </section>
              )}

              {detected.length > 0 && (
                <section className="rounded-2xl border p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="font-extrabold">Detected foods</div>
                      <div className="text-xs text-muted-foreground">
                        Adjust grams before adding.
                      </div>
                    </div>
                    <Button onClick={addDetectedToMeal} size="sm" className="rounded-full">
                      <Plus className="mr-1 h-4 w-4" /> Add all
                    </Button>
                  </div>
                  <FoodRows
                    items={detected}
                    onResize={(id, grams) => resizeItem(detected, setDetected, id, grams)}
                    onRemove={(id) =>
                      setDetected((current) => current.filter((item) => item.id !== id))
                    }
                  />
                </section>
              )}

              <DebugPanel
                debug={visionDebug}
                items={
                  detected.length ? (detected as DetectedFood[]) : (pendingCapture?.items ?? [])
                }
              />

              <section>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-black">Add food</h3>
                    <p className="text-xs text-muted-foreground">Search the quick food library.</p>
                  </div>
                  <div className="flex items-center gap-1 rounded-xl border bg-muted/35 px-2">
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={mealHour}
                      onChange={(event) => setMealHour(event.target.value)}
                      onBlur={() => setMealHour(normalizeTimePart(mealHour, 23))}
                      aria-label="Meal hour"
                      className="h-9 w-12 border-0 bg-transparent p-1 text-center font-bold shadow-none"
                    />
                    <span className="font-black">:</span>
                    <Input
                      type="number"
                      min={0}
                      max={59}
                      value={mealMinute}
                      onChange={(event) => setMealMinute(event.target.value)}
                      onBlur={() => setMealMinute(normalizeTimePart(mealMinute, 59))}
                      aria-label="Meal minute"
                      className="h-9 w-12 border-0 bg-transparent p-1 text-center font-bold shadow-none"
                    />
                  </div>
                </div>
                <div className="relative mt-3">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search chicken, rice, yogurt…"
                    className="h-10 rounded-xl pl-9"
                  />
                </div>
                <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                  {filteredFoods.map((food) => (
                    <button
                      key={food.name}
                      onClick={() => addReferenceFood(food)}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted"
                    >
                      <div>
                        <div className="text-sm font-bold">{food.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          Per 100g · {food.per100.calories} kcal · {food.per100.protein}g protein
                        </div>
                      </div>
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-primary">
                        <Plus className="h-4 w-4" />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <aside className="flex min-h-96 flex-col border-t bg-primary/5 p-5 lg:min-h-0 lg:border-l lg:border-t-0">
              <div className="flex shrink-0 items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-extrabold uppercase tracking-wider text-primary">
                    Review meal
                  </div>
                  <h3 className="mt-0.5 text-lg font-black">
                    {mealItems.length} item{mealItems.length === 1 ? "" : "s"} selected
                  </h3>
                </div>
                <span className="rounded-full bg-card px-3 py-1 text-xs font-extrabold shadow-sm">
                  {Math.round(mealTotals.calories)} kcal
                </span>
              </div>

              <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
                {mealItems.length ? (
                  <FoodRows
                    items={mealItems}
                    onResize={(id, grams) => resizeItem(mealItems, setMealItems, id, grams)}
                    onRemove={(id) =>
                      setMealItems((current) => current.filter((item) => item.id !== id))
                    }
                  />
                ) : (
                  <div className="flex h-full min-h-40 items-center justify-center rounded-2xl border border-dashed bg-card/60 p-5 text-center">
                    <div>
                      <Utensils className="mx-auto h-7 w-7 text-muted-foreground/40" />
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        Scan your plate or choose a food from the middle column to review it here.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 shrink-0">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
                  <ConfirmMacro label="Calories" value={mealTotals.calories} />
                  <ConfirmMacro label="Protein" value={mealTotals.protein} />
                  <ConfirmMacro label="Carbs" value={mealTotals.carbs} />
                  <ConfirmMacro label="Fat" value={mealTotals.fat} />
                </div>

                <Button
                  onClick={() => {
                    if (!mealItems.length) {
                      toast.error("Add at least one food before confirming.");
                      return;
                    }
                    void saveMeal();
                  }}
                  disabled={saving || !mealItems.length}
                  className="mt-4 h-11 w-full rounded-xl font-extrabold"
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving meal…
                    </>
                  ) : (
                    <>
                      <Check className="mr-2 h-4 w-4" /> Confirm and save
                    </>
                  )}
                </Button>

                <Button
                  onClick={() => setEditorOpen(false)}
                  variant="ghost"
                  className="mt-2 w-full rounded-xl font-bold"
                >
                  Close and keep editing later
                </Button>
              </div>
            </aside>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function WeekBar({
  days,
  selectedDate,
  onSelect,
  onPrevious,
  onNext,
  calendarOpen,
  onCalendarOpenChange,
  weekStartsOn,
}: {
  days: Date[];
  selectedDate: string;
  onSelect: (date: Date) => void;
  onPrevious: () => void;
  onNext: () => void;
  calendarOpen: boolean;
  onCalendarOpenChange: (open: boolean) => void;
  weekStartsOn: "monday" | "sunday";
}) {
  return (
    <section className="relative rounded-2xl border bg-card p-2 shadow-sm">
      <div className="flex items-stretch gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onPrevious}
          aria-label="Previous week"
          className="h-auto shrink-0 rounded-xl"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>

        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {days.map((date) => {
            const iso = toIsoDate(date);
            const selected = iso === selectedDate;
            const today = iso === todayIso();
            return (
              <button
                key={iso}
                type="button"
                onClick={() => onSelect(date)}
                className={cn(
                  "min-w-14 flex-1 rounded-xl px-2 py-2 text-center transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted/55 hover:bg-muted",
                )}
              >
                <div className="text-[10px] font-extrabold uppercase opacity-75">
                  {today ? "Today" : date.toLocaleDateString(undefined, { weekday: "short" })}
                </div>
                <div className="text-lg font-black">{date.getDate()}</div>
              </button>
            );
          })}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onNext}
          aria-label="Next week"
          className="h-auto shrink-0 rounded-xl"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>

        <Popover open={calendarOpen} onOpenChange={onCalendarOpenChange}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Open calendar"
              className="h-12 w-12 shrink-0 self-center rounded-md border-primary/20 text-primary"
            >
              <CalendarDays className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto rounded-2xl p-0 shadow-xl">
            <Calendar
              mode="single"
              selected={parseIsoDate(selectedDate)}
              weekStartsOn={weekStartsOn === "monday" ? 1 : 0}
              onSelect={(date) => {
                if (date) onSelect(date);
              }}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>
    </section>
  );
}

function TimelineRow({
  hour,
  meals,
  first,
  last,
  onLog,
  onRemoveFood,
  removingFoodId,
}: {
  hour: number;
  meals: MealEntry[];
  first: boolean;
  last: boolean;
  onLog: () => void;
  onRemoveFood: (meal: MealEntry, foodId: string) => void;
  removingFoodId: string | null;
}) {
  const totals = sumMacros(meals);
  return (
    <div className="grid min-h-20 grid-cols-[58px_22px_minmax(0,1fr)_auto] items-stretch px-3 sm:grid-cols-[72px_28px_minmax(0,1fr)_auto] sm:px-5">
      <div className="pt-5 text-right text-xs font-extrabold text-muted-foreground">
        {formatHour(hour)}
      </div>
      <div className="relative mx-auto w-full">
        {!first && <div className="absolute left-1/2 top-0 h-5 w-px bg-primary/20" />}
        {!last && <div className="absolute bottom-0 left-1/2 top-5 w-px bg-primary/20" />}
        <div
          className={cn(
            "absolute left-1/2 top-5 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-card shadow-sm",
            meals.length ? "bg-primary" : "bg-primary/25",
          )}
        />
      </div>
      <div className="min-w-0 py-3 pr-2">
        {meals.length ? (
          <div className="space-y-1.5">
            {meals.map((meal) => (
              <div key={meal.id} className="overflow-hidden rounded-xl border bg-card">
                <div className="flex items-center justify-between border-b bg-primary/5 px-3 py-1.5">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-primary">
                    Meal at {formatTime(meal.time)}
                  </span>
                  <span className="text-[10px] font-bold text-muted-foreground">
                    {Math.round(sumMacros([meal]).calories)} kcal total
                  </span>
                </div>
                <div className="divide-y">
                  {meal.items.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-extrabold">{item.name}</span>
                          <SourceBadge source={item.source} />
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {Math.round(item.grams)}g · {Math.round(item.calories)} kcal · P{" "}
                          {round(item.protein)} · C {round(item.carbs)} · F {round(item.fat)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemoveFood(meal, item.id)}
                        disabled={removingFoodId === item.id}
                        aria-label={`Remove logged ${item.name}`}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
                      >
                        {removingFoodId === item.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="text-[10px] font-bold text-muted-foreground">
              {Math.round(totals.calories)} kcal in this hour
            </div>
          </div>
        ) : (
          <div className="pt-2 text-xs text-muted-foreground/60">No food logged</div>
        )}
      </div>
      <div className="flex items-start py-3">
        <Button
          type="button"
          onClick={onLog}
          size="sm"
          variant={meals.length ? "outline" : "default"}
          className="rounded-full font-bold"
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> {meals.length ? "Log more" : "Log"}
        </Button>
      </div>
    </div>
  );
}

function FoodRows({
  items,
  onResize,
  onRemove,
}: {
  items: FoodItem[];
  onResize: (id: string, grams: number) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 rounded-xl border p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-extrabold">{item.name}</div>
            <div className="text-[11px] text-muted-foreground">
              {Math.round(item.calories)} kcal · P {round(item.protein)} · C {round(item.carbs)} · F{" "}
              {round(item.fat)}
            </div>
            <div className="mt-1">
              <SourceBadge source={item.source} />
            </div>
          </div>
          <div className="relative shrink-0">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={Math.round(item.grams)}
              onChange={(event) => onResize(item.id, Number(event.target.value))}
              aria-label={`${item.name} weight in grams`}
              className="h-9 w-24 rounded-lg pl-3 pr-7 text-right text-sm font-bold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="pointer-events-none absolute right-2 top-2.5 text-[10px] text-muted-foreground">
              g
            </span>
          </div>
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label={`Remove ${item.name}`}
            className="rounded-lg p-2 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function MacroPanel({ totals, goals }: { totals: Macros; goals: Macros }) {
  const items = [
    {
      label: "Calories",
      value: totals.calories,
      goal: goals.calories,
      icon: Flame,
      color: "bg-leaf",
    },
    { label: "Protein", value: totals.protein, goal: goals.protein, icon: Beef, color: "bg-mango" },
    { label: "Carbs", value: totals.carbs, goal: goals.carbs, icon: Wheat, color: "bg-sky" },
    { label: "Fat", value: totals.fat, goal: goals.fat, icon: Utensils, color: "bg-berry" },
  ];
  return (
    <section className="card-soft p-5">
      <div className="mb-4">
        <h2 className="text-lg font-black">Daily macros</h2>
        <p className="text-xs text-muted-foreground">Based on saved meals for this date.</p>
      </div>
      <div className="space-y-3">
        {items.map(({ label, value, goal, icon: Icon, color }) => {
          const percent = Math.min(100, Math.round((value / goal) * 100));
          return (
            <div key={label}>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 font-bold">
                  <Icon className="h-3.5 w-3.5 text-primary" /> {label}
                </div>
                <div className="text-muted-foreground">
                  <span className="font-extrabold text-foreground">{Math.round(value)}</span> /{" "}
                  {Math.round(goal)}
                </div>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full", color)}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ConfirmMacro({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-muted p-2 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-extrabold">{Math.round(value)}</div>
    </div>
  );
}

function parseIsoDate(date: string) {
  return new Date(`${date}T12:00:00`);
}

function toIsoDate(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function startOfWeek(date: Date, weekStartsOn: "monday" | "sunday") {
  const start = new Date(date);
  const offset = weekStartsOn === "monday" ? (start.getDay() + 6) % 7 : start.getDay();
  start.setDate(start.getDate() - offset);
  start.setHours(12, 0, 0, 0);
  return start;
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function formatLongDate(date: string) {
  return parseIsoDate(date).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatHour(hour: number) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

function formatTime(time: string) {
  const [hour = "0", minute = "0"] = time.split(":");
  return new Date(2000, 0, 1, Number(hour), Number(minute)).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCurrentTime(date: Date) {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeTimePart(value: string, max: number) {
  const number = Math.min(max, Math.max(0, Number.parseInt(value, 10) || 0));
  return number.toString().padStart(2, "0");
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
