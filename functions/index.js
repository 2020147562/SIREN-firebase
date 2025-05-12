/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest} = require("firebase-functions/v2/https");
const multer = require("multer");
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const FormData = require("form-data"); // axios와 함께 사용

const app = express();

// CORS 설정
app.use(cors({origin: true}));

// multer: multipart/form-data 처리 미들웨어, 메모리에 파일 저장
const upload = multer({storage: multer.memoryStorage()});

// POST 요청을 처리, wav와 txt 파일 필드 허용
app.post("/", upload.fields(
    [{name: "audio_file"}, {name: "text_file"}]), async (req, res) => {
  try {
    // 프론트에서 업로드한 파일 추출
    const wavFile = req.files["audio_file"][0];
    const txtFile = req.files["text_file"][0];

    // axios에서 multipart/form-data 전송 위해 FormData 구성
    const formData = new FormData();
    formData.append("audio_file", wavFile.buffer,
        {filename: wavFile.originalname});
    formData.append("text_file", txtFile.buffer,
        {filename: txtFile.originalname});

    // FastAPI 서버로 relay
    const response = await axios.post("http://3.36.56.9:8000/analyze", formData, {
      headers: formData.getHeaders(),
    });

    const dangerScore = response.data.danger_score;

    if (dangerScore > 90) {
      res.status(200).send({
        danger_score: dangerScore,
        result: "경찰에 신고 필요",
      });
    } else if (dangerScore > 75) {
      res.status(200).send({
        danger_score: dangerScore,
        result: "지인에게 신고 필요",
      });
    } else {
      res.status(200).send({
        danger_score: dangerScore,
        result: "안전",
      });
    }
  } catch (err) {
    console.error("Error relaying request:", err.message);
    res.status(500).send({error: "파일 처리 실패"});
  }
});

// Firebase Function으로 내보냄
exports.proxyUpload = onRequest({region: "asia-northeast3"}, app);


// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
