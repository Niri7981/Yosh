#!/bin/bash
set -euo pipefail
repository_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
fixture_directory="${YOSH_UI_REGRESSION_OUTPUT:-$(mktemp -d "${TMPDIR:-/tmp}/yosh-ui-acceptance.XXXXXX")}"
mkdir -p "$fixture_directory"
cd "$repository_root"
app_sources=(
  apps/macos/Yosh/YoshApp/App/AgentCardNSWindow.swift
  apps/macos/Yosh/YoshApp/Materials/CardMaterial.swift
  apps/macos/Yosh/YoshApp/Models/RegisteredAPI.swift
  apps/macos/Yosh/YoshApp/Models/AppOverview.swift
  apps/macos/Yosh/YoshApp/Models/AuthoritySurface.swift
  apps/macos/Yosh/YoshApp/Models/ExecutionEnvironment.swift
  apps/macos/Yosh/YoshApp/Models/PurchasePresentation.swift
  apps/macos/Yosh/YoshApp/Models/ActivityLedgerPresentation.swift
  apps/macos/Yosh/YoshApp/Models/DailyAuthorityPresentation.swift
  apps/macos/Yosh/YoshApp/Models/PurchaseDetailPresentation.swift
  apps/macos/Yosh/YoshApp/Views/Card/CardPageHeader.swift
  apps/macos/Yosh/YoshApp/Views/Card/ActivityDetail.swift
  apps/macos/Yosh/YoshApp/Views/Card/ActivityLedgerRow.swift
  apps/macos/Yosh/YoshApp/Views/Card/DailyAuthorityContent.swift
  apps/macos/Yosh/YoshApp/Views/Card/PurchaseDetail.swift
  apps/macos/Yosh/YoshApp/Views/Card/YoshDetailStack.swift
  apps/macos/Yosh/YoshApp/Views/Card/YoshDetailNavigation.swift
  apps/macos/Yosh/YoshApp/Views/Card/YoshDetailPage.swift
  apps/macos/Yosh/YoshApp/Views/Card/BackSection.swift
  apps/macos/Yosh/YoshApp/Views/Card/YoshTabMotion.swift
)
xcrun swiftc -parse-as-library -swift-version 6 -disable-sandbox "${app_sources[@]}" tests/native/UIAcceptanceRegression.swift -o "$fixture_directory/UIAcceptanceRegression"
result=0
for page in budget purchase; do
  if "$fixture_directory/UIAcceptanceRegression" "$page" > "$fixture_directory/$page.log" 2>&1; then
    cat "$fixture_directory/$page.log"
  else
    status=$?
    cat "$fixture_directory/$page.log"
    printf '%s exited %s\n' "$page" "$status"
    result=1
  fi
done
exit "$result"
