const EventEmitter = require("events");
const OpenAI = require('openai');
const tools = require('../config/tools');

function check_inventory(model) {
  console.log('\x1b[36m%s\x1b[0m', 'GPT -> called check_inventory');
  console.log({ model });
  if (model?.toLowerCase().includes("pro")) {
    return JSON.stringify({ stock: 10 });
  } else if (model?.toLowerCase().includes("max")) {
    return JSON.stringify({ stock: 0 });
  } else {
    return JSON.stringify({ stock: 100 });
  }
}

function check_price(model) {
  console.log('\x1b[36m%s\x1b[0m', 'GPT -> called check_price');
  console.log({ model });
  if (model?.toLowerCase().includes("pro")) {
    return JSON.stringify({ price: 249 });
  } else if (model?.toLowerCase().includes("max")) {
    return JSON.stringify({ price: 549 });
  } else {
    return JSON.stringify({ price: 149 });
  }
}

function place_order(model, quantity) {
  console.log('\x1b[36m%s\x1b[0m', 'GPT -> called place_order');
  console.log({ model }, { quantity });

  // generate a random order number that is 7 digits 
  orderNum = Math.floor(Math.random() * (9999999 - 1000000 + 1) + 1000000);

  // check model and return the order number and price with 7.9% sales tax
  if (model?.toLowerCase().includes("pro")) {
    return JSON.stringify({ orderNumber: orderNum, price: Math.floor(quantity * 249 * 1.079) });
  } else if (model?.toLowerCase().includes("max")) {
    return JSON.stringify({ orderNumber: orderNum, price: Math.floor(quantity * 549 * 1.079) });
  }
  return JSON.stringify({ orderNumber: orderNum, price: Math.floor(quantity * 149 * 1.079) });
}

class GptService extends EventEmitter {
  constructor() {
    super();
    this.openai = new OpenAI();
    this.userContext = [
      { "role": "system", "content": "You are an outbound sales representative selling Apple Airpods. You have a youthful and cheery personality. Keep your responses as brief as possible but make every attempt to keep the caller on the phone without being rude. Don't ask more than 1 question at a time. Don't make assumptions about what values to plug into functions. Ask for clarification if a user request is ambiguous. Speak out all prices to include the currency. Please help them decide between the airpods, airpods pro and airpods max by asking questions like 'Do you prefer headphones that go in your ear or over the ear?'. If they are trying to choose between the airpods and airpods pro try asking them if they need noise canceling. Once you know which model they would like ask them how many they would like to purchase and try to get them to place an order. Add a '•' symbol after every sentence or at natural pauses where your response can be split for text to speech." },
      { "role": "assistant", "content": "Hello! I understand you're looking for a pair of AirPods, is that correct?" },
    ],
      this.partialResponseIndex = 0
    this.currentStream;
    this.interrupted = false;
  }

  userContinuation(text, interactionCount) {
    let lastMessage = this.userContext.pop();
    let newMessage = lastMessage.content + text;
    console.log("changing last mesasge from '" + lastMessage.content + " ' to '" + lastMessage.content + text + "'");
    if (lastMessage.role === 'user') {
      this.userContext.push({
        "role": "user",
        "content": (newMessage)
      });

    } else if (lastMessage.role === 'assistant') {
      lastMessage = this.userContext.pop();
      newMessage = lastMessage.content + text;
      console.log("changing last mesasge from '" + lastMessage.content + " ' to '" + newMessage + "'");
      if (lastMessage.role === 'user') {
        this.userContext.push({
          "role": "user",
          "content": (newMessage)
        });
      }
    }
    this.interrupted = true;
    this.currentStream = null; // close out the current streaming response
    setTimeout(function(){}, 1000);
    this.completion(newMessage, interactionCount); // generate a new completion with the new response
  }


  async completion(text, interactionCount, role = "user", name = "user") {
    if (role === "function") {
      this.userContext.push({ "role": role, "name": name, "content": text })
    } else {
      this.userContext.push({ "role": role, "content": text })
    }

    const availableFunctions = {
      check_inventory: check_inventory,
      check_price: check_price,
      place_order: place_order,
    };

    // Send user transcription to Chat GPT
    this.currentStream = await this.openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      // model: "gpt-4",
      messages: this.userContext,
      tools: tools,
      stream: true,
    });

    let completeResponse = ""
    let partialResponse = ""
    let functionName = ""
    let functionArgs = ""
    let finishReason = ""
    let startdt = new Date();
    for await (const chunk of this.currentStream) {
      if (this.interrupted) {
        this.interrupted = false;
        return;
      }
      let content = chunk.choices[0]?.delta?.content || ""
      let deltas = chunk.choices[0].delta

      // check if GPT wanted to call a function
      if (deltas.tool_calls) {
        console.log(deltas.tool_calls);

        // get the name of the function and any arguments being passed in
        let name = deltas.tool_calls[0]?.function?.name || "";
        if (name != "") {
          // name is only passed the first time so check and make sure we don't overwrite functionName
          functionName = name;
        }
        let args = deltas.tool_calls[0]?.function?.arguments || "";
        if (args != "") {
          // args are streamed as JSON string so we need to concatenate all chunks
          functionArgs += args;
        }
      }
      // check to see if stream is finished which is indicated by finish_reason
      finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason === "tool_calls") {
        // add the assistant's function call to the conversation history
        this.userContext.push({
          role: "assistant",
          content: null,
          function_call: {
            name: functionName,
            arguments: functionArgs,
          },
        });
        // parse JSON string of args into JSON object
        try {
          functionArgs = JSON.parse(functionArgs)
        } catch (error) {
          // was seeing an error where sometimes we have two sets of args
          console.error("double function args detected")
          if (functionArgs.indexOf('{') != functionArgs.lastIndexOf('{'))
            functionArgs = JSON.parse(functionArgs.substring(functionArgs.indexOf(''), functionArgs.indexOf('}') + 1));
        }

        const functionToCall = availableFunctions[functionName];
        let functionResponse = null;
        // execute the correct function with the correct arguments
        if (functionName === 'check_inventory' || functionName === 'check_price') {
          functionResponse = functionToCall(
            functionArgs.model
          );
        } else if (functionName === 'place_order') {
          functionResponse = functionToCall(
            functionArgs.model,
            functionArgs.quantity
          )
        }

        // call the completion function again but pass in the function response to have OpenAI generate a new assistant response
        await this.completion(functionResponse, interactionCount, 'function', functionName)
        return;
      } else {
        // We use completeResponse for userContext
        completeResponse += content;
        // We use partialResponse to provide a chunk for TTS
        partialResponse += content;
        // Emit last partial response and add complete response to userContext
        if (content.trim().slice(-1) === "•" || finishReason === "stop") {
          const gptReply = {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse
          }
          let enddt = new Date();
          this.emit("gptreply", gptReply, interactionCount, startdt, enddt);
          this.partialResponseIndex++;
          partialResponse = ""
        }
      }
    }
    this.userContext.push({ "role": "assistant", "content": completeResponse })
    console.log(`User context length: ${this.userContext.length}`)
    // console.log(this.userContext);
  }
}

module.exports = { GptService }