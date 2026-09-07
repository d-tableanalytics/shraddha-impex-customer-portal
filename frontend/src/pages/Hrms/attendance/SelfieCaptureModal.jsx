import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, ShieldOff } from "lucide-react";

import { Modal } from "../../../components/ui/Modal";
import { Button } from "../../../components/ui/Button";
import {
  openCamera,
  stopStream,
  captureFrame,
  captureMessage,
} from "./deviceCapture";

/**
 * Take the photo that goes with a punch.
 *
 * ---------------------------------------------------------------------------
 * Cancelling does NOT cancel the punch
 * ---------------------------------------------------------------------------
 * The reference's equivalent aborts the whole clock-in when this modal is
 * dismissed, with the message "Selfie is required to clock in". That makes the
 * photograph a condition of being able to record attendance, which AD-15 rules
 * out - consent has to be free to be consent. Here `onSkip` completes the
 * punch without a photo, and the button that does it is as prominent as the
 * one that takes it.
 *
 * ---------------------------------------------------------------------------
 * The camera is stopped on every exit path
 * ---------------------------------------------------------------------------
 * Capture, cancel, unmount, and a re-render that closes the modal all run
 * `stopStream`. A track left running keeps the device's camera indicator lit
 * after the dialog is gone, which reads to the person as being recorded.
 *
 * ---------------------------------------------------------------------------
 * The card's `busy` flag is deliberately NOT threaded into these buttons
 * ---------------------------------------------------------------------------
 * It is true for the whole punch, which INCLUDES the time this dialog is open
 * waiting for an answer - and `Button` disables itself while `loading`. Passing
 * it through disabled Skip, Cancel and Take photo at exactly the moment the
 * person needs them, and the flow could not proceed at all. The only in-flight
 * state this dialog owns is `capturing`.
 */
export function SelfieCaptureModal({ open, onCapture, onSkip, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [capturing, setCapturing] = useState(false);

  const stop = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPreview(null);

    const result = await openCamera();
    if (!result.ok) {
      setError(result.reason);
      return;
    }

    streamRef.current = result.stream;
    if (videoRef.current) {
      // Assigning srcObject is enough: the element carries `autoPlay`, and a
      // muted autoplaying video is allowed by every browser's autoplay policy.
      // Calling `play()` as well adds nothing and produces an unhandled
      // rejection whenever the tab is backgrounded.
      videoRef.current.srcObject = result.stream;
    } else {
      // Modal closed between the permission prompt and the resolution. Nothing
      // will render this stream, so release the camera immediately.
      stop();
    }
  }, [stop]);

  useEffect(() => {
    if (open) start();
    else stop();
    return stop;
  }, [open, start, stop]);

  const handleCapture = async () => {
    setCapturing(true);
    try {
      const blob = await captureFrame(videoRef.current);
      if (!blob) {
        setError("failed");
        return;
      }
      // Freeze the frame the person is about to send, then release the camera
      // - the shot is taken, so there is no reason to keep the device open
      // while the upload runs.
      setPreview(URL.createObjectURL(blob));
      stop();
      onCapture(blob);
    } finally {
      setCapturing(false);
    }
  };

  // Object URLs are not garbage collected on their own; without this the page
  // leaks a blob for every photo taken in a session.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const handleCancel = () => {
    stop();
    onCancel();
  };

  return (
    <Modal isOpen={open} onClose={handleCancel} title="Take a photo for your punch" size="md">
      <div className="flex flex-col gap-4">
        {error ? (
          <div className="flex flex-col gap-3">
            <div
              role="alert"
              className="flex gap-3 p-4 rounded-lg bg-warning-50 border border-warning-200"
            >
              <ShieldOff className="w-5 h-5 text-warning-600 shrink-0 mt-0.5" />
              <div className="text-xs text-slate-700 leading-relaxed">
                <p className="font-semibold text-slate-900 mb-1">Camera unavailable</p>
                <p>{captureMessage(error)}</p>
              </div>
            </div>

            {/*
              The reference offers only Retry and Cancel here, so someone whose
              camera is genuinely broken cannot clock in at all. Continuing
              without a photo is the outcome AD-15 requires to remain available.
            */}
            <div className="flex flex-wrap gap-2 justify-end">
              <Button variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={start}>
                <RefreshCw size={14} className="mr-1.5" />
                Try again
              </Button>
              <Button variant="primary" onClick={onSkip}>
                Continue without a photo
              </Button>
            </div>
          </div>
        ) : preview ? (
          <div className="flex flex-col items-center gap-3">
            <img
              src={preview}
              alt="The photo you just took"
              className="w-full max-h-80 object-cover rounded-xl border border-slate-200"
            />
            <p className="text-xs font-semibold text-success-600">
              Photo taken - recording your punch...
            </p>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              aria-label="Camera preview"
              className="w-full max-h-80 object-cover rounded-xl bg-slate-900 -scale-x-100"
            />

            <p className="text-[11px] text-slate-500 leading-relaxed">
              The photo is stored privately and can only be seen by you, your
              reporting manager and HR. No face recognition is performed.
            </p>

            <div className="flex flex-wrap gap-2 justify-end">
              <Button variant="ghost" onClick={handleCancel}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={onSkip}>
                Skip the photo
              </Button>
              <Button variant="primary" onClick={handleCapture} loading={capturing}>
                <Camera size={15} className="mr-1.5" />
                Take photo
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export default SelfieCaptureModal;
