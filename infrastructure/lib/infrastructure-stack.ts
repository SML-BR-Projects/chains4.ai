import { RemovalPolicy, SecretValue, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { InstanceType, Peer, Port, SecurityGroup, SubnetType, Vpc, InstanceClass, InstanceSize } from "aws-cdk-lib/aws-ec2";
import { Cluster, FargateTaskDefinition, ContainerDefinition, ContainerImage, AwsLogDriver, Secret } from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { FileSystem, LifecyclePolicy, ThroughputMode, PerformanceMode }  from 'aws-cdk-lib/aws-efs';
import { AuroraPostgresEngineVersion, DatabaseCluster, DatabaseClusterEngine, Credentials, ClusterInstance } from 'aws-cdk-lib/aws-rds';
import { Secret as smSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';

const rootDomain = "ai.awsbuilders.cloud";
const flowDomainName = `flowise.${rootDomain}`;
const databaseName = "flowise";
const databaseUsername = "postegres";
const flowisePort = 3000;
const containerFlowPath = "/mnt/flowise";

export class InfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Passphrase to encrypt the keys, which is stored in the secrets manager and needs to be manually updated
    const secretPassphrase = new smSecret(this, 'secret-passphrase', {
      secretObjectValue: {
        passphrase: SecretValue.unsafePlainText("")
      },
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE
    })

    // Flowise credentials to access the flowise, which are stored in the secrets manager and needs to be manually updated
    const secretFlowPass = new smSecret(this, 'secret-flow-pass', {
      secretObjectValue: {
        username: SecretValue.unsafePlainText(""),
        password: SecretValue.unsafePlainText("")
      },
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE
    })

    const vpc = new Vpc(this, "vpc", { maxAzs: 3  });

    const fileSystem = new FileSystem(this, 'efs', {
      vpc: vpc,
      encrypted: true,
      lifecyclePolicy: LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: PerformanceMode.GENERAL_PURPOSE,
      throughputMode: ThroughputMode.BURSTING,
    });

    const dbSecurityGroup = new SecurityGroup(this, 'rds-sec-group', {
      vpc: vpc,
      allowAllOutbound: true,
    })

    const dbCluster = new DatabaseCluster(this, 'rds-cluster', {
      engine: DatabaseClusterEngine.auroraPostgres({ version: AuroraPostgresEngineVersion.VER_15_3 }),
      writer: ClusterInstance.provisioned('writer', { instanceType: InstanceType.of(InstanceClass.R6G, InstanceSize.LARGE ) }),
      vpc,
      vpcSubnets : vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }),
      credentials: Credentials.fromGeneratedSecret(databaseUsername),
      securityGroups: [dbSecurityGroup],
      port: 5432,
      defaultDatabaseName: databaseName,
    });

    const cluster = new Cluster(this, "ecs-cluster", { vpc: vpc, containerInsights: true, enableFargateCapacityProviders: true });

    const taskDef = new FargateTaskDefinition(this, "ecs-task-def", {
      volumes: [
        {
            name: "config",
            efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
            },
        }
      ]
    });

    const containerDef = new ContainerDefinition(this, "ecs-task-container-def", {
      image: ContainerImage.fromAsset("../", { 
        exclude: ["cdk.out", "infrastructure"],
      }),
      portMappings: [{ 
        containerPort: flowisePort 
      }],
      environment : {
        PORT : flowisePort.toString(),
        APIKEY_PATH : containerFlowPath,
        SECRETKEY_PATH : containerFlowPath,
        LOG_PATH : `${containerFlowPath}/logs`,
        LOG_LEVEL : "debug",
        DATABASE_TYPE : "postgres",
        DATABASE_HOST : dbCluster.clusterEndpoint.hostname,
        DATABASE_PORT : dbCluster.clusterEndpoint.port.toString(),
        DATABASE_NAME : databaseName
        // DEBUG : "",
        // EXECUTION_MODE : ""
      },
      secrets : {
        DATABASE_USER : Secret.fromSecretsManager(
          smSecret.fromSecretCompleteArn(this, "ecs-task-container-def-secret-usr", `${dbCluster.secret!.secretArn}:username::`
        )), 
        DATABASE_PASSWORD : Secret.fromSecretsManager( 
          smSecret.fromSecretCompleteArn(this, "ecs-task-container-def-secret-pass", `${dbCluster.secret!.secretArn}:password::`
        )), 
        PASSPHRASE : Secret.fromSecretsManager( 
          smSecret.fromSecretCompleteArn(this, "ecs-task-container-def-secret-passphrase", `${secretPassphrase.secretArn}:passphrase::`
        )),
        FLOWISE_USERNAME : Secret.fromSecretsManager( 
          smSecret.fromSecretCompleteArn(this, "ecs-task-container-def-secret-flow-username", `${secretFlowPass.secretArn}:username::`
        )),
        FLOWISE_PASSWORD : Secret.fromSecretsManager( 
          smSecret.fromSecretCompleteArn(this, "ecs-task-container-def-secret-flow-pass", `${secretFlowPass.secretArn}:password::`
        )),
        
      },
      taskDefinition: taskDef,
      logging: new AwsLogDriver({ streamPrefix: "ecs-logs" }),
    });
    
    taskDef.addToExecutionRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        dbCluster.secret!.secretArn,
        secretPassphrase.secretArn,
        secretFlowPass.secretArn
      ],
    }))

    containerDef.addMountPoints(
      {
        sourceVolume: "config",
        containerPath: containerFlowPath,
        readOnly: false
      }
    )

    const cert = new Certificate(this, "cert", {
      domainName: rootDomain,
      subjectAlternativeNames: [`*.${rootDomain}`],
      validation: CertificateValidation.fromDns(),
    });

    const service = new ApplicationLoadBalancedFargateService(this, "ecs-service", {
      cluster: cluster,
      cpu: 512, 
      desiredCount: 3,
      taskDefinition: taskDef,
      publicLoadBalancer: true,
      domainName: flowDomainName,
      domainZone: HostedZone.fromLookup(this, "hosted-zone", { domainName: rootDomain }),
      certificate: cert,
      redirectHTTP: true,
      capacityProviderStrategies : [
        {
          capacityProvider: "FARGATE_SPOT",
          weight: 1,
          base: 1
        },
        {
          capacityProvider: "FARGATE",
          weight: 0,
          base: 0
        }
      ]
    });

    //TODO: Add the security group to the service
    dbSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(5432),
      'allow inbound traffic from anywhere to the db on port 5432'
    )

    service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');
    fileSystem.connections.allowDefaultPortFrom(service.service.connections); // Allow access to EFS from Fargate ECS

  }
}
