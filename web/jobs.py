"""Background jobs for the long Chrome tasks (create ticket, End uploads, Close, WhatsApp).

A job runs in a thread; the browser polls /api/jobs/<id> for its progress lines and result.
Stop (stopAll) ends whatever is waiting on Chrome - the Stop button.
"""

import secrets
import threading
import time

from kaam.chromeBridge import StoppedError, resetStop

jobsLock = threading.Lock()
jobs = {}
maxJobs = 60  # finished jobs are forgotten after this many


class Job:
    def __init__(self, kind, wo, title):
        self.id = secrets.token_hex(6)
        self.kind = kind
        self.wo = wo
        self.title = title
        self.state = "running"  # running / done / error / stopped
        self.lines = []
        self.data = {}           # live values for the page (ticket ID, EQ Job IDs, CSV path...)
        self.result = None
        self.error = None
        self.startedAt = time.time()
        self.endedAt = None

    def progress(self, text):
        with jobsLock:
            self.lines.append({"at": time.time(), "text": str(text)})

    def post(self, kind, value):
        """Workflow callback: "progress" lines, or values like "ticket" / "jobIds" / "gridFile"."""
        if kind == "progress":
            self.progress(value)
            return
        with jobsLock:
            if kind == "jobIds":
                self.data.setdefault("jobIds", {}).update(value or {})
            else:
                self.data[kind] = value

    def toJson(self):
        with jobsLock:
            return {"id": self.id, "kind": self.kind, "wo": self.wo, "title": self.title, "state": self.state,
                    "lines": list(self.lines), "data": dict(self.data), "result": self.result,
                    "error": self.error, "startedAt": self.startedAt, "endedAt": self.endedAt}


def startJob(kind, wo, title, work):
    """work(job) -> result (JSON-able). Raises -> the job ends with that error."""
    with jobsLock:
        for other in jobs.values():
            if other.state == "running" and other.kind == kind and other.wo == wo:
                return other  # the same thing is already running: show that one
    job = Job(kind, wo, title)
    with jobsLock:
        jobs[job.id] = job
        finished = [j for j in jobs.values() if j.state != "running"]
        for old in sorted(finished, key=lambda j: j.startedAt)[:max(0, len(jobs) - maxJobs)]:
            jobs.pop(old.id, None)
    resetStop()  # an earlier Stop must not cancel this new run

    def run():
        try:
            result = work(job)
            state, error = "done", None
        except StoppedError as stopped:
            result, state, error = None, "stopped", str(stopped)
        except Exception as failure:
            result, state, error = None, "error", str(failure) or failure.__class__.__name__
        with jobsLock:
            job.result, job.state, job.error, job.endedAt = result, state, error, time.time()

    threading.Thread(target=run, daemon=True, name=f"job-{kind}").start()
    return job


def getJob(jobId):
    with jobsLock:
        return jobs.get(jobId)


def listJobs():
    with jobsLock:
        recent = sorted(jobs.values(), key=lambda j: j.startedAt, reverse=True)[:12]
    return [job.toJson() for job in recent]
