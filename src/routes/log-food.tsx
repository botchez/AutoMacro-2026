import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Mascot } from "@/components/Mascot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp, type FoodItem, todayIso } from "@/lib/store";
import { MOCK_FOOD_DB, scaleFood } from "@/lib/mock-foods";
import { Camera, Scale, Trash2, Plus, RefreshCw, Upload, X, Aperture, Usb, Unplug } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useScale } from "@/hooks/use-scale";

export const Route = createFileRoute("/log-food")({
  head: () => ({
    meta: [
      { title: "Log food — NutriCoach" },
      {
        name: "description",
        content: "Scan, weigh, and log meals with the friendly NutriCoach food logger.",
      },
      { property: "og:title", content: "Log a meal with NutriCoach" },
      {
        property: "og:description",
        content: "Batch add foods with our smart scan-and-weigh flow.",
      },
    ],
  }),
  component: LogFood,
});

const uid = () => Math.random().toString(36).slice(2, 10);

function LogFood() {
  const { user, goals, addMeal, logs, ready } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate({ to: "/" });
    else if (!goals) navigate({ to: "/onboarding" });
  }, [ready, user, goals, navigate]);

  // Day selector — last 7 days
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [hour, setHour] = useState(new Date().getHours().toString().padStart(2, "0"));
  const [minute, setMinute] = useState(new Date().getMinutes().toString().padStart(2, "0"));

  const days = useMemo(() => {
    const arr: { iso: string; dow: string; d: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      arr.push({
        iso: d.toISOString().slice(0, 10),
        dow: d.toLocaleDateString(undefined, { weekday: "short" }),
        d: d.getDate(),
      });
    }
    return arr;
  }, []);

  // Scale — live reading from the physical HX711 food scale over Web Serial,
  // with a mock fallback so the demo still works without hardware plugged in.
  const scale = useScale();
  const [mockWeight, setMockWeight] = useState(0);
  const [tareOffset, setTareOffset] = useState(0);
  const [capturedWeight, setCapturedWeight] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [detected, setDetected] = useState<FoodItem[]>([]);
  const [visionProvider, setVisionProvider] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live webcam capture
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

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
      // The <video> mounts on the next render; a useEffect attaches the
      // stream once the element is actually in the DOM (see below).
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

  // Attach the stream once the <video> element is mounted in the DOM.
  // Doing this in an effect (rather than right after getUserMedia) avoids a
  // race where the element hasn't rendered yet, which shows a black frame.
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

  // Live reading: hardware weight (already hardware-tared) when a scale is
  // connected, otherwise the mock value. `tareOffset` is a software fallback
  // for demo mode; `capturedWeight` freezes a reading for the analysis call.
  const liveWeight = Math.max(0, (scale.connected ? (scale.weight ?? 0) : mockWeight) - tareOffset);
  const displayedWeight = capturedWeight ?? liveWeight;

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

  const captureWeight = () => {
    if (scale.connected) {
      setCapturedWeight(liveWeight);
      toast.success("Weight captured!", { description: `Locked in ${liveWeight}g from the scale.` });
      return;
    }
    // No hardware — fall back to a plausible random weight so the demo works.
    const w = Math.round(40 + Math.random() * 360);
    setMockWeight(w);
    setCapturedWeight(Math.max(0, w - tareOffset));
    toast.success("Weight captured!", { description: "Scale reading locked in (demo mode)." });
  };

  const tare = async () => {
    setCapturedWeight(null);
    if (scale.connected) {
      await scale.tare(); // zero the load cell on the hardware
    } else {
      setTareOffset(mockWeight);
    }
    toast("Scale tared to 0g");
  };
  const captureImage = async (file: File) => {
    setScanning(true);
    try {
      const result = await api.analyze(file, displayedWeight);
      const chosen = result.items.map((item) => ({ ...item, id: uid() }));
      setDetected((previous) => [...previous, ...chosen]);
      setVisionProvider(result.provider);
      toast.success(`Detected ${chosen.length} item${chosen.length === 1 ? "" : "s"}!`, {
        description: result.cached
          ? "Loaded from the vision cache."
          : "Nutrition enriched through the food database.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not analyze that image");
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const updateDetected = (id: string, grams: number) => {
    setDetected((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const ref = MOCK_FOOD_DB.find((f) => f.name === it.name);
        const macros = ref
          ? scaleFood(ref.per100, grams)
          : {
              calories: Math.round((it.calories / it.grams) * grams),
              protein: Math.round((it.protein / it.grams) * grams * 10) / 10,
              carbs: Math.round((it.carbs / it.grams) * grams * 10) / 10,
              fat: Math.round((it.fat / it.grams) * grams * 10) / 10,
            };
        return { ...it, grams, ...macros };
      }),
    );
  };

  const removeDetected = (id: string) => setDetected((prev) => prev.filter((it) => it.id !== id));

  const addDetectedToBatch = () => {
    setBatch((b) => [...b, ...detected]);
    setDetected([]);
    setCapturedWeight(null);
    setMockWeight(0);
    setTareOffset(0);
    toast.success("Added to batch");
  };

  // Batch
  const [batch, setBatch] = useState<FoodItem[]>([]);

  const submitBatch = async () => {
    if (!batch.length) {
      toast.error("Add at least one food first!");
      return;
    }
    try {
      await addMeal(selectedDate, {
        id: uid(),
        time: `${hour}:${minute}`,
        items: batch,
      });
      setBatch([]);
      toast.success("Meal logged! 🎉", { description: "Saved to your nutrition history." });
      navigate({ to: "/dashboard" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save meal");
    }
  };

  const batchTotals = batch.reduce(
    (a, it) => ({
      calories: a.calories + it.calories,
      protein: a.protein + it.protein,
      carbs: a.carbs + it.carbs,
      fat: a.fat + it.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  // Coach suggestions
  const suggestion = useMemo(() => {
    if (!goals) return "";
    const dayLog = logs.find((d) => d.date === selectedDate);
    const soFar = (dayLog?.meals ?? []).flatMap((m) => m.items).concat(batch);
    const totals = soFar.reduce(
      (a, it) => ({
        calories: a.calories + it.calories,
        protein: a.protein + it.protein,
        carbs: a.carbs + it.carbs,
        fat: a.fat + it.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    const gaps: string[] = [];
    if (totals.protein < goals.protein * 0.5) gaps.push("protein (try eggs, yogurt, or chicken)");
    if (totals.carbs < goals.carbs * 0.5) gaps.push("carbs (rice, oats, or fruit)");
    if (totals.fat < goals.fat * 0.5) gaps.push("healthy fats (avocado, olive oil, nuts)");
    if (!gaps.length) return "You're crushing it — keep the balance going!";
    return `You're low on ${gaps.join(" and ")}. Consider adding some to this meal!`;
  }, [batch, goals, logs, selectedDate]);

  return (
    <AppLayout>
      <div className="space-y-6">
        <header className="flex items-center gap-4">
          <Mascot size={64} className="animate-float shrink-0" />
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">Log a meal</div>
            <h1 className="text-2xl md:text-3xl">Snap, weigh, log</h1>
            <div className="text-xs text-muted-foreground">I'll cheer you on the whole way 🎉</div>
          </div>
        </header>

        {/* Day selector */}
        <div className="card-soft p-3 flex gap-2 overflow-x-auto">
          {days.map((d) => (
            <button
              key={d.iso}
              onClick={() => setSelectedDate(d.iso)}
              className={cn(
                "shrink-0 rounded-2xl px-4 py-2 text-center bounce-tap min-w-[64px]",
                selectedDate === d.iso ? "bg-primary text-primary-foreground shadow" : "bg-muted",
              )}
            >
              <div className="text-[10px] uppercase font-bold opacity-80">{d.dow}</div>
              <div className="text-lg font-extrabold">{d.d}</div>
            </button>
          ))}
        </div>

        {/* Time */}
        <div className="card-soft p-4 flex items-center gap-3">
          <div className="text-sm font-bold">Time</div>
          <Input
            type="number"
            min={0}
            max={23}
            value={hour}
            onChange={(e) => setHour(e.target.value.padStart(2, "0").slice(-2))}
            className="w-20 text-center font-bold text-lg"
          />
          <span className="text-lg font-extrabold">:</span>
          <Input
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={(e) => setMinute(e.target.value.padStart(2, "0").slice(-2))}
            className="w-20 text-center font-bold text-lg"
          />
        </div>

        {/* Scanner */}
        <div className="card-soft p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg">📸 Smart food scanner</h2>
            <div className="text-xs text-muted-foreground">
              {visionProvider ? `Cascade: ${visionProvider}` : "Vision + FDC cascade"}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            {/* Camera */}
            <div className="rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-6 text-center min-h-[180px] flex flex-col items-center justify-center">
              {scanning ? (
                <>
                  <RefreshCw className="h-10 w-10 animate-spin text-primary" />
                  <div className="mt-2 text-sm font-bold">Analyzing your plate…</div>
                </>
              ) : cameraOn ? (
                <div className="w-full flex flex-col items-center">
                  <div className="relative w-full overflow-hidden rounded-2xl bg-black">
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full max-h-[240px] object-contain"
                    />
                    <button
                      onClick={stopCamera}
                      aria-label="Close camera"
                      className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white bounce-tap"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      onClick={capturePhoto}
                      className="rounded-full font-bold bounce-tap"
                    >
                      <Aperture className="mr-2 h-4 w-4" /> Capture photo
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Camera className="h-10 w-10 text-primary" />
                  <div className="mt-2 text-sm font-bold">Point at your plate</div>
                  <div className="text-xs text-muted-foreground">
                    Use your webcam or upload an image to detect foods
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void captureImage(file);
                    }}
                  />
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <Button
                      onClick={startCamera}
                      disabled={cameraStarting}
                      className="rounded-full font-bold bounce-tap"
                    >
                      {cameraStarting ? (
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Camera className="mr-2 h-4 w-4" />
                      )}
                      {cameraStarting ? "Starting…" : "Open camera"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-full font-bold bounce-tap"
                    >
                      <Upload className="mr-2 h-4 w-4" /> Upload image
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Scale */}
            <div className="rounded-2xl bg-gradient-to-br from-sky/15 to-primary/10 p-6 flex flex-col items-center justify-center">
              <Scale className="h-8 w-8 text-sky-600" />
              <div className="mt-2 text-5xl font-black tabular-nums">
                {displayedWeight}
                <span className="text-xl text-muted-foreground">g</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "inline-block h-2 w-2 rounded-full",
                    scale.connected ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40",
                  )}
                />
                {scale.connected
                  ? capturedWeight !== null
                    ? "Reading locked"
                    : "Live scale reading"
                  : "Demo mode — scale not connected"}
              </div>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={tare} className="rounded-full bounce-tap">
                  Tare
                </Button>
                <Button onClick={captureWeight} className="rounded-full font-bold bounce-tap">
                  Capture Weight
                </Button>
              </div>
              <div className="mt-2">
                {scale.connected ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void scale.disconnect()}
                    className="rounded-full text-xs bounce-tap"
                  >
                    <Unplug className="mr-1 h-3.5 w-3.5" /> Disconnect
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void connectScale()}
                    className="rounded-full text-xs bounce-tap"
                  >
                    <Usb className="mr-1 h-3.5 w-3.5" /> Connect scale
                  </Button>
                )}
              </div>
            </div>
          </div>

          {detected.length > 0 && (
            <div className="mt-5">
              <div className="text-sm font-bold mb-2">Detected items — tweak portions:</div>
              <ul className="space-y-2">
                {detected.map((it) => (
                  <li
                    key={it.id}
                    className="rounded-2xl border p-3 flex items-center gap-3 animate-pop"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-bold truncate">{it.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {it.calories} kcal · P {it.protein} · C {it.carbs} · F {it.fat}
                      </div>
                    </div>
                    <Input
                      type="number"
                      value={it.grams}
                      onChange={(e) => updateDetected(it.id, Number(e.target.value))}
                      className="w-20 text-center font-bold"
                    />
                    <span className="text-xs text-muted-foreground">g</span>
                    <button
                      onClick={() => removeDetected(it.id)}
                      className="text-destructive p-1 bounce-tap"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
              <Button
                onClick={addDetectedToBatch}
                className="mt-3 w-full rounded-full font-bold bounce-tap"
              >
                <Plus className="mr-1 h-4 w-4" /> Add to meal batch
              </Button>
            </div>
          )}
        </div>

        {/* Coach suggestions */}
        <div className="card-soft p-4 flex items-start gap-3 bg-gradient-to-r from-sun/15 to-primary/10">
          <Mascot size={56} className="animate-float shrink-0" />
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wider text-primary font-bold">Coach tip</div>
            <div className="text-sm font-semibold">{suggestion}</div>
          </div>
        </div>

        {/* Batch */}
        <div className="card-soft p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg">🥗 In this meal ({batch.length})</h2>
            <div className="text-xs text-muted-foreground">
              {batchTotals.calories} kcal · P {batchTotals.protein.toFixed(0)} · C{" "}
              {batchTotals.carbs.toFixed(0)} · F {batchTotals.fat.toFixed(0)}
            </div>
          </div>

          {batch.length ? (
            <ul className="space-y-2">
              {batch.map((it) => (
                <li key={it.id} className="rounded-xl bg-muted p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold truncate">{it.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {it.grams}g · {it.calories} kcal
                    </div>
                  </div>
                  <button
                    onClick={() => setBatch((b) => b.filter((x) => x.id !== it.id))}
                    className="text-destructive p-1 bounce-tap"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-center py-6 text-sm text-muted-foreground">
              No items yet. Capture an image or add from the scanner.
            </div>
          )}

          <Button
            onClick={submitBatch}
            size="lg"
            className="mt-4 w-full rounded-full font-bold bounce-tap"
          >
            Save meal 🎉
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
