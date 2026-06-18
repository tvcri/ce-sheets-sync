import { createConnection } from './db-util.js'
import { info, warn } from './logger.js'

const VILLAGE_NAME_MAP = {
  'Aquidneck Island': 'Aquidneck'
}

const ACTIVITY_TYPE_MAP = {
  'Companionship/Friendly Conversation (sharing stories, current events, photos)': 'companionship',
  'Shared Activity (board game, cards, puzzles, craft)': 'activity',
  'Assistance (reading aloud, writing a letter, helping with simple tasks)': 'assistance',
  'Outdoors (walking, gardening, birding, etc)': 'outdoors',
  'Outing ( events, movies, Sr Center,  etc.)': 'outing',
  'Dining out': 'dining',
  'Wellness check-in (follow up after illness or hospitalization)': 'wellness',
  'Pet visit': 'pet',
  'Other': 'other'
}

function normalizeVillageName(name) {
  return VILLAGE_NAME_MAP[name] ?? name
}

function mapActivityTypes(answers) {
  if (!answers || answers.length === 0) return []
  return answers.map(a => ACTIVITY_TYPE_MAP[a] ?? a)
}

export { normalizeVillageName, mapActivityTypes }
