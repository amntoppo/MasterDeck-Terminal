import { resolve } from 'node:path'
import { parseConfig, setConfig } from './shared/appConfig'
import raw from '../../skills/master/tests/config.json'

// Tests run against the same fictional config as the Python tests (org "acme", repo "tracker").
setConfig(parseConfig(raw))
process.env.MASTER_CONFIG = resolve(__dirname, '../../skills/master/tests/config.json')
