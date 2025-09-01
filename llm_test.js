// llm_test.js - Test script for Google AI Studio Gemini integration
import { GoogleGenerativeAI } from '@google/generative-ai'
import { config } from 'dotenv'
config()

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ 
  model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  generationConfig: {
    temperature: 0.7,
    topP: 0.9,
    maxOutputTokens: 512,
  }
})

// Test cases
const testCases = [
  {
    name: "Instruction Parsing - Simple Movement",
    prompt: `You are a planner for a Minecraft bot named TryChlorophyll/Phyll.
Given an instruction, output a JSON plan of steps. If told to move to a set of coordinates, prefer to pathfind there. If told to move to a player, prefer to teleport there.

Valid actions:
- {"action":"follow","player":"<player>"}
- {"action":"goto","x":<int>,"y":<int>,"z":<int>}
- {"action":"tpa","player":"<player>"}
- {"action":"wait","seconds":<int>}

Rules:
- Output ONLY valid JSON, no extra text.
- Use integers for numbers.
- If the player to follow/teleport isn't specified, use "TestPlayer".
- If nothing actionable, return {"steps": []}.

Instruction: "come to me"
JSON:`,
    validate: (response) => {
      try {
        const json = JSON.parse(response);
        return json.steps && 
               json.steps.length > 0 && 
               json.steps[0].action === "tpa" && 
               json.steps[0].player === "TestPlayer";
      } catch {
        return false;
      }
    }
  },
  {
    name: "Instruction Parsing - Coordinates",
    prompt: `You are a planner for a Minecraft bot named TryChlorophyll/Phyll.
Given an instruction, output a JSON plan of steps. If told to move to a set of coordinates, prefer to pathfind there. If told to move to a player, prefer to teleport there.

Valid actions:
- {"action":"follow","player":"<player>"}
- {"action":"goto","x":<int>,"y":<int>,"z":<int>}
- {"action":"tpa","player":"<player>"}
- {"action":"wait","seconds":<int>}

Rules:
- Output ONLY valid JSON, no extra text.
- Use integers for numbers.
- If the player to follow/teleport isn't specified, use "TestPlayer".
- If nothing actionable, return {"steps": []}.

Instruction: "go to 100 64 200"
JSON:`,
    validate: (response) => {
      try {
        const json = JSON.parse(response);
        return json.steps && 
               json.steps.length > 0 && 
               json.steps[0].action === "goto" && 
               json.steps[0].x === 100 && 
               json.steps[0].y === 64 && 
               json.steps[0].z === 200;
      } catch {
        return false;
      }
    }
  },
  {
    name: "Conversation Response",
    prompt: `You are Phyll, a concise Minecraft assistant.
Owner: TryChloroform. Trusted: TryChloroform.
Respond briefly and naturally to the last user message.

Last message: "Hello, how are you?"
Reply:`,
    validate: (response) => {
      return typeof response === 'string' && 
             response.length > 0 && 
             response.length < 150; // Reasonable response length
    }
  },
  {
    name: "Personality Response",
    prompt: `You are Phyll, a Minecraft bot with a short, slightly sarcastic style.
Event: I got hurt
Reply in one short, natural sentence. No emojis, no quotes, avoid unnecessary text or jokes.`,
    validate: (response) => {
      return typeof response === 'string' && 
             response.length > 0 && 
             response.length < 100 &&
             !response.includes('{') && // Should not contain JSON
             !response.includes('}');
    }
  }
]

async function runTests() {
  console.log("Starting LLM integration tests...\n")
  
  let passed = 0
  let failed = 0
  
  for (const testCase of testCases) {
    console.log(`Testing: ${testCase.name}`)
    
    try {
      const result = await model.generateContent(testCase.prompt)
      const response = await result.response
      const text = response.text()
      
      console.log(`Prompt: ${testCase.prompt.substring(0, 100)}...`)
      console.log(`Response: ${text.substring(0, 100)}...`)
      
      if (testCase.validate(text)) {
        console.log("PASSED\n")
        passed++
      } else {
        console.log("FAILED - Validation failed\n")
        failed++
      }
    } catch (error) {
      console.log("FAILED - Error:", error.message, "\n")
      failed++
    }
    
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  
  console.log(`Test Results: ${passed} passed, ${failed} failed`)
  
  if (failed === 0) {
    console.log("The LLM integration is working correctly.")
  } else {
    console.log("Some tests failed. Check the API key and model configuration.")
  }
}

runTests()