"""Open ActixOne in your normal Chrome and upload the drive logs for each equipment.

1. Open the upload page directly; sign in only if ActixOne sends us to its login page
   ("Login with Microsoft", your account, Chrome's saved password).
2. On /outdoor/upload: add the extra email, attach every file from the newest log
   folder for the WO, and click the validate (shield) button.
3. With ACTIX_SUBMIT on: click Submit, wait for the upload and return its Job ID.
   With it off: stop before Submit.
EQ tabs stay open until the ticket is Done in the app.
"""

import re
import urllib.parse

from .chromeBridge import ChromeBridgeError, StoppedError, openInChrome, registerFiles, runInChrome
from .config import actixExtraEmail as extraEmail  # all from .env
from .config import actixSubmit, actixUploadUrl, closeTabsWhenDone, equipments, microsoftAccount
from .logFiles import LogFilesError, findLatestLogFiles


def prepareActixUpload(wo, equipment="EQ3", submit=actixSubmit, url=actixUploadUrl,
                       account=microsoftAccount, email=extraEmail, openUrl=openInChrome,
                       startTimeout=25, timeout=20 * 60, closeTab=closeTabsWhenDone):
    """One equipment (EQ3 or EQ6) in the ActixOne tab (the last run's tab is reused).
    closeTab: close the tab once this upload is done - only for the last EQ, so the next one reuses it.
    Returns (summary, jobId, tabToken) - jobId is None when submit is off; tabToken lets the
    app close that tab later. Errors carry .tabToken too when a tab was opened."""
    try:
        files = findLatestLogFiles(wo, equipment)
    except LogFilesError as error:
        raise ChromeBridgeError(str(error))

    def buildUrl(requestId):
        registerFiles(requestId, files)
        return f"{url}#" + urllib.parse.urlencode({
            "kaamLogin": requestId, "kaamAccount": account, "kaamEmail": email,
            "kaamFiles": ",".join(f.name for f in files), "kaamSubmit": "1" if submit else "0", "kaamClose": "1" if closeTab else "0",
        })

    message = runInChrome(
        buildUrl, openUrl=openUrl, startTimeout=startTimeout, timeout=timeout,
        timeoutMessage="ActixOne didn't finish. Check the ActixOne tab in Chrome.",
    )
    tabToken = message.get("requestId")
    if not message.get("ok"):
        error = ChromeBridgeError(message.get("error") or "Couldn't get the ActixOne upload ready.")
        error.tabToken = tabToken
        raise error
    return message.get("summary") or "ActixOne upload is ready.", message.get("jobId"), tabToken


# Errors from the email step (often a half-screen window): worth one more try.
emailStepError = re.compile(r"email field|type the email", re.I)


def prepareAllUploads(wo, onProgress=lambda text: None, onResult=lambda equipment, jobId: None,
                      onTab=lambda token: None, alreadyDone=None):
    """Each equipment in turn in the same ActixOne tab, in .env order. One failing doesn't stop the others.
    An EQ that failed at the email step is tried once more at the end - only if another EQ uploaded
    fine (so ActixOne itself works). Any other error is left for you to look at.
    alreadyDone: {"EQ3": "AJO-TX-..."} for EQs uploaded earlier - those are skipped, not redone.
    onResult(equipment, jobId) runs the moment each Job ID arrives (so it can be saved at once);
    onTab(token) for every tab opened. Returns (summaries, errors, jobIds)."""
    alreadyDone = alreadyDone or {}
    summaries, jobIds = [], {}
    failed = {}  # equipment -> error text
    toUpload = [equipment for equipment in equipments if not alreadyDone.get(equipment)]

    def upload(equipment, closeTab, label=""):
        onProgress(f"ActixOne upload for {equipment}{label}…")
        try:
            summary, jobId, tabToken = prepareActixUpload(wo, equipment, closeTab=closeTab)
            onTab(tabToken)
            summaries.append(f"{equipment}: {summary}")
            failed.pop(equipment, None)
            if jobId:
                jobIds[equipment] = jobId
                onResult(equipment, jobId)
        except StoppedError:
            raise  # Stop pressed: don't go on to the next EQ
        except ChromeBridgeError as error:
            onTab(getattr(error, "tabToken", None))
            failed[equipment] = str(error)

    for equipment in equipments:
        if alreadyDone.get(equipment):
            jobIds[equipment] = alreadyDone[equipment]
            summaries.append(f"{equipment}: already uploaded earlier, Job ID {alreadyDone[equipment]} (skipped)")
            continue
        # One tab for all EQs: only the last upload closes it (EQ3 leaves it open for EQ6). With a
        # retry coming, the retry is the last one instead.
        last = equipment == toUpload[-1] and not any(emailStepError.search(e) for e in failed.values())
        upload(equipment, closeTabsWhenDone and last)

    retry = [eq for eq, error in failed.items() if emailStepError.search(error)]
    if retry and any(eq in jobIds for eq in toUpload):
        for n, equipment in enumerate(retry):
            first = failed[equipment]
            upload(equipment, closeTabsWhenDone and n == len(retry) - 1, " (one more try - the email step failed)")
            if equipment in failed:
                failed[equipment] = f"{failed[equipment]} (tried twice; first try: {first})"                     if failed[equipment] != first else f"{first} (tried twice)"
            else:
                summaries.append(f"{equipment}: worked on the second try (first try: {first})")
    errors = [f"{equipment}: {error}" for equipment, error in failed.items()]
    return summaries, errors, jobIds

if __name__ == "__main__":
    import sys
    done, failed, ids = prepareAllUploads(sys.argv[1], print)
    print("\n".join(done + failed), ids)
