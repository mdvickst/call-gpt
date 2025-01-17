require("dotenv").config();
const express = require("express");
const ExpressWs = require("express-ws");
const uuid = require('uuid');

const { GptService } = require("./services/gpt-service");
const { StreamService } = require("./services/stream-service");
const { TranscriptionService } = require("./services/transcription-service");
const { TextToSpeechService } = require("./services/tts-service");
const { FirebaseService } = require("./services/fb-service");

const app = express();
ExpressWs(app);
app.use(express.static('public'))
const PORT = process.env.PORT || 3000;
var fbid = '';
var conId = '';
var isUtterance = false;
let lastUtterance = new Date(Date.now());
const fbService = new FirebaseService();
app.post("/incoming", (req, res) => {
  conId = uuid.v4();
  res.status(200);
  res.type("text/xml");
  res.end(`
  <Response>
    <Connect>
      <Stream url="wss://${process.env.SERVER}/connection" />
    </Connect>
  </Response>
  `);
});

app.ws("/connection", (ws, req) => {
  ws.on("error", console.error);
  // Filled in from start message
  let streamSid;

  const gptService = new GptService();
  const streamService = new StreamService(ws);
  const transcriptionService = new TranscriptionService();
  const ttsService = new TextToSpeechService({});

  let marks = []
  let interactionCount = 0
  let assistantResponding = false;

  // Incoming from MediaStream
  ws.on("message", function message(data) {
    const msg = JSON.parse(data);
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      streamService.setStreamSid(streamSid);
      console.log(`Starting Media Stream for ${streamSid}`);
      ttsService.generate({ partialResponseIndex: null, partialResponse: "Hello! I understand you're looking for a pair of AirPods, is that correct?" }, 1);
    } else if (msg.event === "media") {
      transcriptionService.send(msg.media.payload);
    } else if (msg.event === "mark") {
      const label = msg.mark.name;
      console.log(`Media completed mark (${msg.sequenceNumber}): ${label}`)
      marks = marks.filter(m => m !== msg.mark.name)
      if (marks.length == 0) {
        assistantResponding = false;
        console.log("agent no longer responding")
      }
    } else if (msg.event === "stop") {
      console.log(`Media stream ${streamSid} ended.`)
    }
  });

  transcriptionService.on("utterance", async (text) => {
    // This is a bit of a hack to filter out empty utterances
    if (marks.length > 0 && text?.length > 5) {
      console.log("Interruption, Clearing stream")
      ws.send(
        JSON.stringify({
          streamSid,
          event: "clear",
        })
      );
      // if (Date.now() - lastUtterance <= 2500) {
      //   gptService.userContinuation(text, interactionCount);
      // }
    }
  });

  transcriptionService.on("transcription", async (text, startdt, enddt) => {
    if (!text) { return; }
    console.log(`Interaction ${interactionCount} – STT -> GPT: ${text}`);
    fbid = uuid.v4();
    type = 'phone'
    await fbService.setLogs(text, fbid, conId, 'Deepgram', startdt, enddt);
    await fbService.setTranscript(text, fbid, conId, type);

    // check to see if user speaking over the assistant and the last utterance was less than 2.5 seconds ago
    // this would be if the user had a long pause but wasn't done speaking yet
    // console.log("ms since last utterance=" + String(Date.now() - lastUtterance));
    if ((marks.length > 0 || assistantResponding) && text?.length > 1) {
      console.log("Interruption, Clearing stream")
      ws.send(
        JSON.stringify({
          streamSid,
          event: "clear",
        })
      );
      gptService.userContinuation(text, interactionCount);
    } else {
      gptService.completion(text, interactionCount);
      interactionCount += 1;
    }
    lastUtterance = Date.now();
    assistantResponding = true;
    console.log("agent is responding")
  });

  gptService.on('gptreply', async (gptReply, icount, startdt, enddt) => {
    console.log(`Interaction ${icount}: GPT -> TTS: ${gptReply.partialResponse}`)
    fbid = uuid.v4();
    type = 'bot'
    await fbService.setLogs(gptReply.partialResponse, fbid, conId, 'OpenAI', startdt, enddt);
    await fbService.setTranscript(gptReply.partialResponse, fbid, conId, type);
    ttsService.generate(gptReply, icount);
  });

  ttsService.on("speech", (responseIndex, audio, label, icount, startdt, enddt) => {
    console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`);
    fbid = uuid.v4();
    fbService.setLogs(label, fbid, conId, 'ElevenLabs', startdt, enddt);
    streamService.buffer(responseIndex, audio);
  });

  streamService.on('audiosent', (markLabel) => {
    marks.push(markLabel);
  })
});

app.get('/getSessionId', function (req, res) {
  res.json([{ id: conId }]);
})

app.get('/getAllTranscripts', async function (req, res) {
  //res.send("this is a test" + conId);
  let alltrans = await fbService.getAllTranscripts();
  if (alltrans) {
    let readfs = alltrans;
    res.json(readfs);
  }

})

app.get('/getAllLogs', async function (req, res) {
  //res.send("this is a test" + conId);
  let alllogs = await fbService.getAllLogs();
  if (alllogs) {
    let readfs = alllogs;
    res.json(readfs);
  }


})

app.get('/getTranscriptById', async function (req, res) {
  //res.send("this is a test" + conId);
  //const response = "This is a test " + conId;
  let response = fbService.getTranscriptById('11ee566c-880d-4708-8261-c95f947e0faf');

  res.json(response);
})


app.listen(PORT);
console.log(`Server running on port ${PORT}`);
