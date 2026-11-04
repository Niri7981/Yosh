import Observation

/// Unsaved form values shared by the two grant editors. Authority stays in the backend.
@MainActor @Observable
final class SpendGrantForm {
    var draft: SpendGrantDraft
    var selectedResourceID: String
    var sampleQuery: String
    var sampleBody: String

    init(overview: AppOverview) {
        draft = SpendGrantDraft(grant: overview.scopedGrant)
        let resource = overview.service.registeredResources?.first {
            $0.resourceId == overview.scopedGrant?.resourceId
        }
        selectedResourceID = resource?.resourceId ?? ""
        sampleQuery = resource?.submission?.sample.queryText ?? ""
        sampleBody = resource?.submission?.sample.bodyText ?? ""
    }
}
