# Wiz Technical Exercise -  Deployment Guide

## Prerequisites
- AWS CLI configured (`aws configure`)
- kubectl installed
- Docker installed
- eksctl installed
- helm installed
- EC2 Key Pair created in region

---

## PHASE 1: Initial AWS Setup

### 1.1 Create an EC2 Key Pair (if you don't have one)
```bash
aws ec2 create-key-pair \
  --key-name wiz-exercise-key \
  --query 'KeyMaterial' \
  --output text > wiz-exercise-key.pem
chmod 400 wiz-exercise-key.pem
```

### 1.2 Find the correct Ubuntu 20.04 AMI for your region
```bash
aws ec2 describe-images \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text
```
Update the `ImageId` in `02-mongodb-vm.yaml` with the output.

---

## PHASE 2: Deploy CloudFormation Stacks (in order)

### 2.1 Deploy Networking Stack
```bash
aws cloudformation deploy \
  --template-file 01-networking.yaml \
  --stack-name wiz-exercise-networking \
  --parameter-overrides ProjectName=wiz-exercise \
  --capabilities CAPABILITY_IAM \
  --region us-east-1
```

### 2.2 Deploy MongoDB VM Stack
```bash
aws cloudformation deploy \
  --template-file 02-mongodb-vm.yaml \
  --stack-name wiz-exercise-mongodb \
  --parameter-overrides \
    ProjectName=wiz-exercise \
    KeyPairName=wiz-exercise-key \
    MongoPassword=WizExercise2024! \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

Get the MongoDB private IP (used later for K8s secret):
```bash
MONGO_PRIVATE_IP=$(aws cloudformation describe-stacks \
  --stack-name wiz-exercise-mongodb \
  --query "Stacks[0].Outputs[?OutputKey=='MongoPrivateIP'].OutputValue" \
  --output text)
echo "MongoDB Private IP: $MONGO_PRIVATE_IP"
```

### 2.3 Deploy EKS Stack (takes ~15 minutes)
```bash
aws cloudformation deploy \
  --template-file 03-eks-cluster.yaml \
  --stack-name wiz-exercise-eks \
  --parameter-overrides ProjectName=wiz-exercise \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

### 2.4 Deploy Security Controls Stack
```bash
aws cloudformation deploy \
  --template-file 04-security-controls.yaml \
  --stack-name wiz-exercise-security \
  --parameter-overrides \
    ProjectName=wiz-exercise \
    AlertEmail=your-email@example.com \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

---

## PHASE 3: Build & Push the Container Image

### 3.1 Update wizexercise.txt with your name
```bash
# Edit app/Dockerfile and replace "Your Full Name" with your actual name
# Line: RUN echo "Your Full Name" > /app/wizexercise.txt
```

### 3.2 Authenticate Docker with ECR
```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ECR_URI
```

### 3.3 Build and push the container image
### Creates the container image that packages Node.js todo application along with the wizexercise.txt file containing my name. This image is what Kubernetes will pull and run as pods. Docker uses the image name/tag to determine where to push. Without tagging with the ECR URI, docker push would not know which registry to send the image to.
```bash
cd app
docker build -t wiz-exercise-app:latest .
docker tag wiz-exercise-app:latest $ECR_URI/wiz-exercise-app:latest
docker push $ECR_URI/wiz-exercise-app:latest
cd ..
```
### ECR also runs a vulnerability scan automatically on push since ScanOnPush: true was set in the CloudFormation template.

---

## PHASE 4: Configure kubectl and Install Load Balancer Controller

### 4.1 Update kubeconfig
### Fetches the EKS cluster's connection details (API server endpoint, certificate authority, authentication token) and writes them to ~/.kube/config. This is the configuration file kubectl reads to know how to connect to your cluster.
```bash
aws eks update-kubeconfig \
  --name wiz-exercise-eks \
  --region us-east-1
kubectl get nodes  # Verify connection
```

### 4.2 Install AWS Load Balancer Controller
```bash
# Add EKS Helm chart repo
# The AWS Load Balancer Controller is distributed as a Helm chart. You must add the repository before Helm can find and install the chart.
helm repo add eks https://aws.github.io/eks-charts
helm repo update

# Creates an IAM OpenID Connect (OIDC) identity provider in your AWS account that is linked to your EKS cluster. This enables Kubernetes service accounts to assume IAM roles using web identity federation.
# Without the OIDC provider, Kubernetes pods cannot assume IAM roles. The Load Balancer Controller needs an IAM role to call AWS APIs (EC2, ELB) to create and manage load balancers. This is the prerequisite for that IAM role association to work.
eksctl utils associate-iam-oidc-provider \
  --cluster wiz-exercise-eks \
  --region us-east-1 \
  --approve

# Create IAM role for the LB controller
# The Load Balancer Controller runs as a pod in kube-system and needs AWS permissions to create ALBs, security groups, and target groups. IRSA is the secure way to grant AWS permissions to specific pods without giving all nodes broad permissions.
eksctl create iamserviceaccount \
  --cluster=wiz-exercise-eks \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --role-name AmazonEKSLoadBalancerControllerRole \
  --attach-policy-arn=arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess \
  --approve

# Attach IAM Policy
# Step 1: Download the correct official IAM policy for the LB controller
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json

# Step 2: Create the policy
aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

# Step 3: Attach the policy to LB Controller IAM Role
aws iam attach-role-policy \
  --role-name AmazonEKSLoadBalancerControllerRole \
  --policy-arn arn:aws:iam::491085397166:policy/AWSLoadBalancerControllerIAMPolicy

# Install the controller
# This controller is what watches for Kubernetes Ingress resources and automatically provisions AWS Application Load Balancers in response.
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=wiz-exercise-eks \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller

kubectl -n kube-system get deployment aws-load-balancer-controller
```

---

## PHASE 5: Deploy the Application to Kubernetes

### 5.1 Update the manifest with your values
Edit `k8s/app-manifests.yaml`:
1. Replace `<MONGO_PRIVATE_IP>` with the value from Phase 2.2
2. Replace `<AWS_ACCOUNT_ID>` and `<AWS_REGION>` with your values

```bash
# Or use sed:
sed -i "s|<MONGO_PRIVATE_IP>|${MONGO_PRIVATE_IP}|g" k8s/app-manifests.yaml
sed -i "s|<AWS_ACCOUNT_ID>|${ACCOUNT_ID}|g" k8s/app-manifests.yaml
sed -i "s|<AWS_REGION>|${REGION}|g" k8s/app-manifests.yaml
```

### 5.2 Apply the manifests
### Reads the manifest file and submits all Kubernetes resources defined in it to the cluster API server. Creates or updates the Namespace, Secret, ServiceAccount, ClusterRoleBinding, Deployment, Service, and Ingress resources.
```bash
kubectl apply -f k8s/app-manifests.yaml
```

### 5.3 Wait for pods to be ready
```bash
kubectl get pods -n wiz-app -w
# Wait until all pods show Running
```

### 5.4 Get the load balancer URL
```bash
kubectl get ingress -n wiz-app
# Copy the ADDRESS field - this is your app URL
```

---

## PHASE 6: Verify Everything Works

### 6.1 Validate wizexercise.txt in running container
### You need the exact pod name to run kubectl exec commands against it. Pod names contain a random suffix (e.g. wiz-todo-app-6d8f9b-xk2pv) that changes every deployment, so you cannot hardcode it.
### Exec commmand opens a process inside the running container and executes cat /app/wizexercise.txt, printing its contents to your terminal. The -- separates kubectl arguments from the command being run inside the container.
```bash
POD=$(kubectl get pods -n wiz-app -l app=wiz-todo-app \
  -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n wiz-app $POD -- cat /app/wizexercise.txt
```

### 6.2 Verify the web app and MongoDB data
```bash
# Get app URL
APP_URL=$(kubectl get ingress wiz-todo-ingress -n wiz-app \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Test health
curl http://$APP_URL/health

# Add a todo via the API
curl -X POST http://$APP_URL/todos \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "title=Wiz+Exercise+Test+Item"

# List todos (proves data in MongoDB)
curl http://$APP_URL/api/todos | jq
```

### 6.3 Verify MongoDB backup
```bash
# SSH to the MongoDB VM
MONGO_PUBLIC_IP=$(aws cloudformation describe-stacks \
  --stack-name wiz-excercise \
  --query "Stacks[0].Outputs[?OutputKey=='MongoPublicIP'].OutputValue" \
  --output text)

ssh -i wiz-exercise-key.pem ubuntu@$MONGO_PUBLIC_IP

# Show active CRON JOB
cat /etc/cron.d/mongo-backup

# Show mongo-backup.log for successful runs
cat /var/log/mongo-backup.log

# On the VM - run manual backup to test
sudo /usr/local/bin/mongo-backup.sh

# Verify in S3
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3 ls s3://wiz-exercise-mongodb-backups-${ACCOUNT_ID}/backups/
```

### 6.4 Verify MongoDB connection (from VM)
```bash
mongo --username admin --password WizExercise2024! --authenticationDatabase admin
> show dbs
> use todos
> db.todos.find()
```

### 6.5 Key kubectl commands for demo
```bash
# Show all resources
# Lists every resource (pods, services, deployments, replicasets, ingresses) in the wiz-app namespace in one command.
kubectl get all -n wiz-app

# Show cluster admin binding (the misconfiguration)
# This gives the todo app pod complete unrestricted access to everything in the Kubernetes cluster — every namespace, every resource, every operation.
kubectl get clusterrolebindings wiz-app-cluster-admin -o yaml

# Why It Is a Misconfiguration
# The todo app is a simple web application. All it needs to do is:
# - Serve HTTP requests
# - Read and write todos to MongoDB

# It has zero legitimate reason to interact with the Kubernetes API at all. Yet with this binding, the pod can:
# Create/delete any pod in any namespace
# Read all Secrets cluster-wide (including other apps' DB passwords)
# Modify RBAC rules themselves
# Deploy new workloads
# Delete entire namespaces
# Access the underlying node via privileged pod creation
# Exfiltrate data from any other application running in the cluster
# Backdoor the cluster by creating new admin accounts

# Show the secret
kubectl get secret mongo-secret -n wiz-app

# Show pod details
kubectl describe pod -n wiz-app -l app=wiz-todo-app

# Show logs
kubectl logs -n wiz-app -l app=wiz-todo-app

# Get into a running pod
kubectl exec -it -n wiz-app $POD -- /bin/sh
```

---

## PHASE 7: Set Up GitHub CI/CD (DevSecOps Bonus)

### 7.1 Push code to GitHub
```bash
git init
git add .
git commit -m "feat: Wiz exercise infrastructure and app"
git remote add origin https://github.com/<your-username>/wiz-exercise.git
git push -u origin main
```

### 7.2 Add GitHub Secrets
Go to GitHub repo → Settings → Secrets → Actions, and add:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `EC2_KEY_PAIR_NAME` → `wiz-exercise-key`
- `MONGO_PASSWORD` → `WizExercise2024!`
- `ALERT_EMAIL` → your email

### 7.3 Enable Branch Protection
GitHub repo → Settings → Branches → Add rule for `main`:
- Require pull request reviews
- Require status checks to pass (select the scan jobs)
- Restrict direct pushes

### 7.4 Trigger Pipeline for Demo
cd ~/wiz-exercise

# Add a demo route to the app to show a code change flowing through
# Infra pipeline
cd ~/wiz-exercise

# Add a meaningful tag change to the networking template
# This simulates an infrastructure change going through the pipeline
cat >> 01-networking.yaml << 'EOF'

  # Demo tag added to show pipeline trigger
EOF

git add 01-networking.yaml
git commit -m "demo: trigger infrastructure pipeline - networking update"
git push origin main

# Application Pipeline
cat >> app/server.js << 'EOF'

// Demo endpoint added to trigger pipeline
app.get('/demo', (req, res) => {
  res.json({
    message: 'Pipeline triggered successfully',
    timestamp: new Date().toISOString(),
    wizexercise: require('fs').readFileSync('/app/wizexercise.txt', 'utf8').trim()
  });
});
EOF

git add app/server.js
git commit -m "feat: add demo endpoint to trigger application pipeline"
git push origin main

---

## Security Misconfigurations Summary (for your presentation)

| Resource | Misconfiguration | Risk |
|---|---|---|
| EC2 (MongoDB VM) | Ubuntu 20.04 (EOL) | Known unpatched CVEs |
| MongoDB | Version 4.4 (EOL Feb 2024) | Unpatched vulnerabilities |
| EC2 Security Group | SSH open to 0.0.0.0/0 | Brute force / unauthorized access |
| EC2 IAM Role | EC2FullAccess + S3FullAccess | Privilege escalation, lateral movement |
| S3 Backup Bucket | Public read + list | Data exposure, backup exfiltration |
| K8s ServiceAccount | cluster-admin binding | Full cluster compromise from pod |

## Detective Controls Implemented
- **CloudTrail**: All API calls logged (control plane audit logging)
- **GuardDuty**: Threat detection across EC2, K8s, S3 (with Malware Protection)
- **AWS Config Rules**: Continuous compliance evaluation (SSH open, S3 public, etc.)
- **EventBridge → SNS**: Real-time alerts for HIGH/CRITICAL GuardDuty findings

## Preventative Controls Implemented
- **ECR Image Scanning**: Trivy scan in CI/CD before push
- **Checkov IaC Scanning**: Scans CloudFormation templates before deploy
- **MongoDB Auth**: Requires authentication (restricted to VPC CIDR)
- **EKS Private Subnets**: Worker nodes not directly internet-accessible
- **EKS Audit Logging**: All K8s API calls captured
