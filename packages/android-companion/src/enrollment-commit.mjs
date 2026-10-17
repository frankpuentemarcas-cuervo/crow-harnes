/** Apply enrollment results while retaining partial-failure feedback after profile activation resets notices. */
export function commitEnrollmentResults(values, notice, actions) {
  actions.bumpGeneration()
  actions.appendProfiles(values)
  actions.activateProfile(values[0].id)
  if (notice) actions.setError(notice)
  else {
    actions.closeEnrollment()
    actions.showHome()
  }
}
