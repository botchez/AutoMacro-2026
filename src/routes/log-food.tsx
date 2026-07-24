import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Mascot } from "@/components/Mascot";
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
import { api } from "@/lib/api";
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
  const { user, goals, addMeal, updateMeal, deleteMeal, logs, ready } = useApp();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialDate = useMemo(() => parseIsoDate(todayIso()), []);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [weekStart, setWeekStart] = useState(() => startOfWeek(initialDate));
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
  // Live webcam capture
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Live barcode auto-scan bookkeeping. `last` de-dupes repeat toasts for an unmatched
  // code; `weight` lets the scan loop (which only re-subscribes on cameraOn) read fresh
  // grams without restarting.
  const lastBarcodeRef = useRef<string | null>(null);
  const weightRef = useRef(0);
  const [detected, setDetected] = useState<FoodItem[]>([]);
  const [mealItems, setMealItems] = useState<FoodItem[]>([]);
  const [visionProvider, setVisionProvider] = useState<string | null>(null);
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

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  };

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Camera not supported", {
        description: "Your browser can't access a webcam. Upload an image instead.",
      });
      return;
    }
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
      setCameraStarting(false);
    }
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      toast.error("Camera isn't ready yet — give it a second.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) {
      toast.error("Couldn't capture the frame. Try again.");
      return;
    }
    const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });
    stopCamera();
    await captureImage(file);
  };

  // Attach the stream once the <video> element is mounted. Doing this in an effect
  // (rather than right after getUserMedia) avoids a race where the element hasn't
  // rendered yet, which shows a black frame.
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
  }, [cameraOn]);

  // Release the camera when leaving the page.
  useEffect(() => stopCamera, []);

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
    setWeekStart(startOfWeek(date));
    setCalendarOpen(false);
  };

  const shiftWeek = (days: number) => {
    const nextDate = addDays(parseIsoDate(selectedDate), days);
    setSelectedDate(toIsoDate(nextDate));
    setWeekStart(startOfWeek(nextDate));
  };

  const openLogEditor = (hour: number) => {
    setMealHour(hour.toString().padStart(2, "0"));
    setMealMinute("00");
    setEditorOpen(true);
  };

  const openLogNow = () => {
    const now = new Date();
    const today = todayIso();
    setSelectedDate(today);
    setWeekStart(startOfWeek(parseIsoDate(today)));
    setMealHour(now.getHours().toString().padStart(2, "0"));
    setMealMinute(now.getMinutes().toString().padStart(2, "0"));
    setEditorOpen(true);
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

  const captureImage = async (file: File) => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
    setScanning(true);
    try {
      // The server cascade decodes any barcode in the frame (pyzbar) before the model,
      // so a captured/uploaded barcode photo already resolves to the exact product.
      const result = await api.analyze(file, capturedWeight || displayedWeight);
      const items = result.items.map((item) => ({ ...item, id: uid() }));
      setDetected(items);
      setVisionProvider(result.provider);
      toast.success(`Found ${items.length} food${items.length === 1 ? "" : "s"}`, {
        description: "Review portions before adding them to the meal.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not analyze that image");
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

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
            const res = await api.scanBarcodeFrame(frame, weightRef.current);
            if (cancelled) return;
            if (res.status === "matched" && res.result) {
              stopCamera(); // flips cameraOn -> this effect's cleanup halts the loop
              const items = res.result.items.map((item) => ({ ...item, id: uid() }));
              setDetected(items);
              setVisionProvider(res.result.provider);
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

  if (!goals) return null;

  return (
    <AppLayout>
      <div className="space-y-5">
        <header className="flex items-center gap-4">
          <Mascot size={64} className="animate-float shrink-0" />
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
        />

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="card-soft overflow-hidden">
            <div className="flex items-center justify-between border-b bg-white px-5 py-4">
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
            <section className="rounded-2xl border bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-primary shadow-sm">
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
              <Button onClick={openLogNow} className="mt-4 w-full rounded-xl font-extrabold">
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
        <DialogContent className="flex h-[92vh] max-h-[860px] w-[calc(100%-1rem)] flex-col overflow-hidden rounded-3xl p-0 sm:max-w-5xl">
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

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(280px,42%)_minmax(0,1fr)] lg:grid-cols-[1.1fr_0.9fr] lg:grid-rows-1">
            <div className="flex min-h-0 flex-col overflow-hidden border-b lg:border-b-0 lg:border-r">
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

              <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-foreground/95 p-5 text-white">
                {cameraOn ? (
                  <div className="relative z-10 flex w-full flex-col items-center">
                    <div className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-black">
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="max-h-[300px] w-full object-contain"
                      />
                      <button
                        type="button"
                        onClick={stopCamera}
                        aria-label="Close camera"
                        className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <Button
                      onClick={() => void capturePhoto()}
                      variant="secondary"
                      className="mt-4 rounded-full font-bold"
                    >
                      <Aperture className="mr-2 h-4 w-4" /> Capture photo
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
                          className="rounded-full font-bold text-foreground"
                        >
                          <Upload className="mr-2 h-4 w-4" /> Upload image
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="min-h-0 space-y-4 overflow-y-auto p-5">
              <section className="rounded-2xl bg-gradient-to-br from-sky/10 to-primary/10 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">
                      <Scale className="h-4 w-4 text-sky-600" /> Scale display
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

              <section className="rounded-2xl border bg-primary/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-extrabold uppercase tracking-wider text-primary">
                      Review meal
                    </div>
                    <h3 className="mt-0.5 text-lg font-black">
                      {mealItems.length} item{mealItems.length === 1 ? "" : "s"} selected
                    </h3>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-extrabold shadow-sm">
                    {Math.round(mealTotals.calories)} kcal
                  </span>
                </div>

                <div className="mt-3 max-h-52 overflow-y-auto pr-1">
                  {mealItems.length ? (
                    <FoodRows
                      items={mealItems}
                      onResize={(id, grams) => resizeItem(mealItems, setMealItems, id, grams)}
                      onRemove={(id) =>
                        setMealItems((current) => current.filter((item) => item.id !== id))
                      }
                    />
                  ) : (
                    <div className="rounded-xl border border-dashed bg-white/60 p-4 text-center text-xs text-muted-foreground">
                      Scan your plate or choose a food above to review it here.
                    </div>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-4 gap-2">
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
                      <Check className="mr-2 h-4 w-4" /> Review complete · Confirm and save
                    </>
                  )}
                </Button>
              </section>

              <Button
                onClick={() => setEditorOpen(false)}
                variant="ghost"
                className="w-full rounded-xl font-bold"
              >
                Close and keep editing later
              </Button>
            </div>
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
}: {
  days: Date[];
  selectedDate: string;
  onSelect: (date: Date) => void;
  onPrevious: () => void;
  onNext: () => void;
  calendarOpen: boolean;
  onCalendarOpenChange: (open: boolean) => void;
}) {
  return (
    <section className="relative rounded-2xl border bg-white p-2 shadow-sm">
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
            "absolute left-1/2 top-5 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-white shadow-sm",
            meals.length ? "bg-primary" : "bg-primary/25",
          )}
        />
      </div>
      <div className="min-w-0 py-3 pr-2">
        {meals.length ? (
          <div className="space-y-1.5">
            {meals.map((meal) => (
              <div key={meal.id} className="overflow-hidden rounded-xl border bg-white">
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
                        <div className="truncate text-sm font-extrabold">{item.name}</div>
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
          </div>
          <div className="relative">
            <Input
              type="number"
              min={1}
              value={Math.round(item.grams)}
              onChange={(event) => onResize(item.id, Number(event.target.value))}
              aria-label={`${item.name} weight in grams`}
              className="h-9 w-18 rounded-lg pr-6 text-right text-sm font-bold"
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

function startOfWeek(date: Date) {
  const start = new Date(date);
  const offset = (start.getDay() + 6) % 7;
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
