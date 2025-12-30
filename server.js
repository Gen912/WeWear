// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const cors = require("cors");
const path = require("path");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB limit (adjust if needed)
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MESHY_API_KEY = process.env.MESHY_API_KEY;
if (!MESHY_API_KEY) {
  console.error("MESHY_API_KEY not set in .env");
  process.exit(1);
}
const MESHY_HEADERS = {
  Authorization: `Bearer ${MESHY_API_KEY}`,
  "Content-Type": "application/json",
};

const FASHN_API_KEY = process.env.FASHN_API_KEY;
if (!FASHN_API_KEY) {
  console.error("FASHN_API_KEY not set in .env");
  process.exit(1);
}
const FASHN_HEADERS = {
  Authorization: `Bearer ${FASHN_API_KEY}`,
  "Content-Type": "application/json",
};

// POST /image-to-3d
// Accepts either:
// - multipart/form-data with file field 'image'
// - or JSON with image_url (public URL or data URI)
app.post("/image-to-3d", upload.single("image"), async (req, res) => {
  try {
    let payload = {};

    if (req.file) {
      // convert uploaded file buffer to data URI
      const mime = req.file.mimetype || "image/png";
      const base64 = req.file.buffer.toString("base64");
      payload.image_url = `data:${mime};base64,${base64}`;
    } else if (req.body && req.body.image_url) {
      payload.image_url = req.body.image_url;
    } else {
      return res.status(400).json({ error: "Provide an image file or image_url" });
    }

    const booleanFields = ["should_remesh", "should_texture", "enable_pbr", "is_a_t_pose", "moderation"];
const numberFields = ["target_polycount"];

for (const k of Object.keys(req.body)) {
  let v = req.body[k];

  if (booleanFields.includes(k)) {
    v = v === "true" || v === true;
  } else if (numberFields.includes(k)) {
    v = Number(v);
  }

  payload[k] = v;
}


    // default: enable texturing
    if (payload.should_texture === undefined) payload.should_texture = true;

    const response = await axios.post(
      "https://api.meshy.ai/openapi/v1/image-to-3d",
      payload,
      { headers: MESHY_HEADERS }
    );

    // return Meshy response to client
    res.json(response.data);
  } catch (err) {
    console.error("create task error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/fashn/tryon", upload.fields([{ name: "person" }, { name: "garment" }]), async (req, res) => {
  try {
    const personFile = req.files?.person?.[0];
    const garmentFile = req.files?.garment?.[0];

    if (!personFile || !garmentFile) {
      return res.status(400).json({ error: "Please upload both person and garment images." });
    }

    // Convert both to data URIs (base64)
    const personMime = personFile.mimetype || "image/jpeg";
    const garmentMime = garmentFile.mimetype || "image/jpeg";
    const personB64 = personFile.buffer.toString("base64");
    const garmentB64 = garmentFile.buffer.toString("base64");
    const model_image = `data:${personMime};base64,${personB64}`;
    const garment_image = `data:${garmentMime};base64,${garmentB64}`;

    // Pick up optional params from body (string booleans to real booleans / numbers where needed)
    const bool = (v, d=false) => (v === "true" || v === true ? true : v === "false" || v === false ? false : d);
    const num  = (v) => (v === undefined ? undefined : Number(v));

    const payload = {
      model_name: "tryon-v1.6",
      inputs: {
        model_image,
        garment_image,
      },
      // Optional top-level params:
      category: req.body.category || "auto",
      segmentation_free: bool(req.body.segmentation_free, true),
      moderation_level: req.body.moderation_level || "permissive",
      garment_photo_type: req.body.garment_photo_type || "auto",
      mode: req.body.mode || "balanced",
      seed: num(req.body.seed) ?? 42,
      num_samples: Math.min(Math.max(num(req.body.num_samples) ?? 1, 1), 4),
      output_format: req.body.output_format || "png",
      return_base64: bool(req.body.return_base64, false),
    };

    const { data } = await axios.post("https://api.fashn.ai/v1/run", payload, { headers: FASHN_HEADERS });
    // Example response: { id: "prediction-id", error: null }
    res.json(data);
  } catch (err) {
    console.error("FASHN /fashn/tryon error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// GET /fashn/tryon/:id - poll FASHN prediction status
app.get("/fashn/tryon/:id", async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    // Status endpoint (per FASHN docs)
    const { data } = await axios.get(`https://api.fashn.ai/v1/status/${id}`, { headers: FASHN_HEADERS });
    res.json(data);
  } catch (err) {
    console.error("FASHN status error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Optional: SSE streamer like Meshy (poll every 2s)
app.get("/fashn/events/:id", (req, res) => {
  const { id } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  let stopped = false;
  const interval = setInterval(async () => {
    if (stopped) return;
    try {
      const { data } = await axios.get(`https://api.fashn.ai/v1/status/${encodeURIComponent(id)}`, { headers: FASHN_HEADERS });
      res.write(`data: ${JSON.stringify(data)}\n\n`);

      if (data.status && (data.status === "completed" || data.status === "failed")) {
        res.write(`event: finished\ndata: ${JSON.stringify(data)}\n\n`);
        clearInterval(interval);
        stopped = true;
        res.end();
      }
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      clearInterval(interval);
      stopped = true;
      res.end();
    }
  }, 2000);

  req.on("close", () => {
    stopped = true;
    clearInterval(interval);
  });
});

// GET /image-to-3d/:taskId - retrieve task status
app.get("/image-to-3d/:taskId", async (req, res) => {
  const { taskId } = req.params;
  try {
    const { data } = await axios.get(
      `https://api.meshy.ai/openapi/v1/image-to-3d/${encodeURIComponent(taskId)}`,
      { headers: MESHY_HEADERS }
    );
    res.json(data);
  } catch (err) {
    console.error("retrieve task error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// SSE endpoint to stream updates to browser (polls Meshy every 2s)
app.get("/events/:taskId", (req, res) => {
  const { taskId } = req.params;

  // keep connection open
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  let stopped = false;
  const intervalMs = 2000;
  const interval = setInterval(async () => {
    if (stopped) return;
    try {
      const { data } = await axios.get(
        `https://api.meshy.ai/openapi/v1/image-to-3d/${encodeURIComponent(taskId)}`,
        { headers: MESHY_HEADERS }
      );

      // send the whole JSON as an SSE message
      res.write(`data: ${JSON.stringify(data)}\n\n`);

      if (data.status && ["SUCCEEDED", "FAILED", "CANCELED"].includes(data.status)) {
        clearInterval(interval);
        stopped = true;
        res.write(`event: finished\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      }
    } catch (err) {
      clearInterval(interval);
      stopped = true;
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      res.end();
    }
  }, intervalMs);

  req.on("close", () => {
    stopped = true;
    clearInterval(interval);
  });
});

// GET /download?url=<encoded_url> -> proxy download (avoids CORS)
app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing url query param");

  try {
    const decoded = decodeURIComponent(url);
    const remote = await axios.get(decoded, { responseType: "stream" });
    const filename = path.basename(decoded.split("?")[0]);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    remote.data.pipe(res);
  } catch (err) {
    console.error("download error:", err.message || err);
    res.status(500).json({ error: err.message || "download failed" });
  }
});

// health
app.get("/health", (req, res) => {
  res.json({ status: "ok", api_key_configured: Boolean(MESHY_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`🚀 Meshy Image→3D server running on http://localhost:${PORT}`);
});
