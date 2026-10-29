import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REACT_DOCTOR_VERSION, reactDoctorBin } from '../src/workflows/review/react-doctor.ts'

test('react-doctor defaults to this repo’s install of the pinned version', () => {
  expect(reactDoctorBin({})).toBe(
    join(
      homedir(),
      '.local/share/agent-workflows/react-doctor',
      REACT_DOCTOR_VERSION,
      'node_modules/.bin/react-doctor',
    ),
  )
})

test('AGW_REACT_DOCTOR_BIN overrides the default', () => {
  expect(reactDoctorBin({ AGW_REACT_DOCTOR_BIN: ' /opt/rd/react-doctor ' })).toBe('/opt/rd/react-doctor')
})
