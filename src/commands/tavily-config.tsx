import * as React from 'react'
import type { Command } from '../commands'
import { Config } from '../components/Config'

const command: Command = {
  type: 'local-jsx',
  name: 'tavily-config',
  aliases: ['tavily-settings', 'tavily-setup'],
  description: 'Open Tavily settings to enable the tool and set the API key',
  isEnabled: true,
  isHidden: false,
  async call(onDone) {
    return <Config onClose={onDone} initialSettingId="tavilyApiKey" />
  },
  userFacingName() {
    return this.name
  },
}

export default command
