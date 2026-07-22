#!/usr/bin/env node

const readline = require('node:readline')

const rl = readline.createInterface({ input: process.stdin })

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { resources: {} },
      serverInfo: { name: 'fixture-resources', version: '1.0.0' },
    })
    return
  }
  if (message.method === 'resources/list') {
    send(message.id, {
      resources: [
        {
          uri: 'fixture://config',
          name: 'config',
          description: 'Fixture JSON config',
          mimeType: 'application/json',
        },
      ],
    })
    return
  }
  if (message.method === 'resources/read') {
    send(message.id, {
      contents: [
        {
          uri: message.params.uri,
          mimeType: 'application/json',
          text: '{"ok":true}',
        },
      ],
    })
    return
  }
})
