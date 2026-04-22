import OpenAI from 'openai'

async function main() {
  const client = new OpenAI()

  console.log('Test 1: Simple text...')
  const resp = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Say hello in one word.' }],
    max_completion_tokens: 100,
  })
  console.log('OK:', resp.choices[0]?.message?.content)

  console.log('\nTest 2: Tool use...')
  const toolResp = await client.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Read the file at /tmp/test.txt' }],
    max_completion_tokens: 200,
    tools: [{
      type: 'function',
      function: {
        name: 'FileRead',
        description: 'Read a file',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
      },
    }],
  })
  console.log('Tool calls:', JSON.stringify(toolResp.choices[0]?.message?.tool_calls))
}

main().catch(err => {
  console.error('Fatal:', err.message?.slice(0, 300))
  process.exit(1)
})
