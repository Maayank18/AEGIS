// Run: node src/utils/testGroq.js
// Verifies Groq API key and streaming work before main build begins.

import { groq, MODEL } from '../config.js';

async function testBasicCompletion() {
  console.log('\n[1/3] Testing basic completion...');
  const res = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with only: AEGIS_ONLINE' }],
    max_tokens: 20,
  });
  const text = res.choices[0].message.content.trim();
  console.log(`     Response: "${text}"`);
  if (!text.includes('AEGIS_ONLINE')) throw new Error('Unexpected response');
  console.log('     ✅ Basic completion OK');
}

async function testStreaming() {
  console.log('\n[2/3] Testing streaming...');
  const stream = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'Count to 5, one number per word.' }],
    stream: true,
    max_tokens: 30,
  });

  let full = '';
  process.stdout.write('     Stream: ');
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || '';
    process.stdout.write(token);
    full += token;
  }
  console.log('\n     ✅ Streaming OK');
}

async function testFunctionCalling() {
  console.log('\n[3/3] Testing function calling (tool use)...');
  const res = await groq.chat.completions.create({
    model: MODEL,
    messages: [{
      role: 'user',
      content: 'Use the get_weather tool for zone CP.'
    }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a zone',
        parameters: {
          type: 'object',
          properties: { zone: { type: 'string' } },
          required: ['zone'],
        },
      },
    }],
    tool_choice: 'auto',
    max_tokens: 100,
  });

  const toolCalls = res.choices[0].message.tool_calls;
  if (!toolCalls || toolCalls.length === 0) throw new Error('No tool call returned');
  console.log(`     Tool called: ${toolCalls[0].function.name}`);
  console.log(`     Arguments:   ${toolCalls[0].function.arguments}`);
  console.log('     ✅ Function calling OK');
}

async function run() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   AEGIS — Phase 0 Groq Verification  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`   Model: ${MODEL}`);

  try {
    await testBasicCompletion();
    await testStreaming();
    await testFunctionCalling();
    console.log('\n✅ ALL CHECKS PASSED — Groq is ready for AEGIS\n');
  } catch (err) {
    console.error('\n❌ VERIFICATION FAILED:', err.message);
    console.error('   Check your GROQ_API_KEY in .env\n');
    process.exit(1);
  }
}

run();